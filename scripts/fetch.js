#!/usr/bin/env node
// Fetch all sources, normalize, and write sorted NDJSON to data/normalized/.
// Run: npm run fetch
//
// Each source is checked against editingInfo.lastEditDate (where available);
// unchanged sources are skipped. State is stored in data/.meta.json.
//
// NOTE: ArcGIS services are reachable from your Mac and GitHub Actions,
// but NOT from Claude's sandbox or the Cowork VM.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import { fetchAllFeatures, fetchEditDate } from './lib/arcgis.js';
import { normalize as normalizeDenver }    from './adapters/denver.js';
import { normalize as normalizeAurora }    from './adapters/aurora.js';
import { normalize as normalizeLakewood }  from './adapters/lakewood.js';
import { normalize as normalizeBikeDenver } from './adapters/bike-denver.js';
import { normalize as normalizeBikeDRCOG } from './adapters/bike-drcog.js';
import { normalize as normalizeSpeedDRCOG } from './adapters/speed-drcog.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NORMALIZED_DIR = join(ROOT, 'data/normalized');
const META_FILE = join(ROOT, 'data/.meta.json');

const SOURCES = [
  // --- pavement (phase 1) ---
  {
    id: 'denver',
    url: 'https://services1.arcgis.com/zdB7qR0BtYrg0Xpl/arcgis/rest/services/Denver_Pavement_Treatments/FeatureServer/428',
    fields: 'OBJECTID,MASTER_ID,GIS_FULLNAME,FROMNAME,TONAME,Jurisdiction,CCD_Treatment,Committed_Year,YR_LSTWK,MORATORIUM_THRU_YEAR,SMDCrew,TreatmentComment,EstimatedOCR,Lane_Miles',
    normalize: normalizeDenver,
  },
  {
    id: 'aurora',
    url: 'https://services3.arcgis.com/0Va1ID99NSrNyyPX/arcgis/rest/services/Pavement_Condition_Index_2025_View_Only/FeatureServer/0',
    fields: 'OBJECTID,STREET_NAM,PCI,PCI_Category,IRI,Normalized_IRI,IRI_Category',
    normalize: normalizeAurora,
  },
  {
    id: 'lakewood',
    url: 'https://egis.lakewood.org/server/rest/services/PW/cgPavement/MapServer/3',
    fields: 'OBJECTID,cg_Street,cg_FromStreet,cg_ToStreet,cg_EstimatedOCI,cg_CurrentInspectionOCI,cg_CurrentInspectionDate,lgSs_LAST_OVERLAY_YEAR,lgSs_NEXT_OVERLAY_YEAR,lgSs_LAST_CRACKSEAL_YEAR,lgSs_LAST_RECLAMITE_YEAR,lgSs_LAST_CONCRETE_YEAR',
    normalize: normalizeLakewood,
  },

  // --- bike facilities (phase 3) ---
  {
    id: 'bike_denver',
    url: 'https://services1.arcgis.com/zdB7qR0BtYrg0Xpl/arcgis/rest/services/Denver_Bicycle_Facilities_ODC/FeatureServer/450',
    fields: '*', // service rejects specific field lists; adapter picks what it needs
    where: "DISPLAY_STATUS LIKE 'Existing Bikeway%'",
    normalize: normalizeBikeDenver,
  },
  {
    id: 'bike_drcog',
    url: 'https://services2.arcgis.com/lCUrzfRwZYxmwIse/arcgis/rest/services/Bicycle_Facilities/FeatureServer/0',
    fields: '*', // service rejects specific field lists; adapter picks what it needs
    normalize: normalizeBikeDRCOG,
  },

  // --- speed limits (phase 3) ---
  {
    id: 'speed_drcog',
    url: 'https://services2.arcgis.com/lCUrzfRwZYxmwIse/arcgis/rest/services/Regional_Speed_Limit/FeatureServer/0',
    fields: 'FID,speed_limi,street_nam,data_sourc',
    oidField: 'FID',   // this service uses FID instead of OBJECTID for pagination orderBy
    normalize: normalizeSpeedDRCOG,
  },
];

function loadMeta() {
  return existsSync(META_FILE) ? JSON.parse(readFileSync(META_FILE, 'utf8')) : {};
}

function saveMeta(meta) {
  writeFileSync(META_FILE, JSON.stringify(meta, null, 2) + '\n');
}

async function fetchSource(source, meta) {
  const { id, url, fields, where, oidField, normalize } = source;
  console.log(`\n[${id}]`);

  const lastEditDate = await fetchEditDate(url);
  const prev = meta[id] || {};

  if (lastEditDate && prev.lastEditDate && lastEditDate === prev.lastEditDate) {
    const d = new Date(lastEditDate).toISOString().slice(0, 10);
    console.log(`  Unchanged since ${d} — skipping. Delete data/.meta.json to force re-fetch.`);
    return false;
  }

  console.log('  Fetching…');
  const features = await fetchAllFeatures(url, { fields, where, oidField });

  const records = features.map(f => normalize(f)).filter(Boolean);
  console.log(`  ${records.length.toLocaleString()} records normalized`);

  // Sort by id for stable git diffs
  records.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const ndjson = records.map(r => JSON.stringify(r)).join('\n') + '\n';
  mkdirSync(NORMALIZED_DIR, { recursive: true });
  writeFileSync(join(NORMALIZED_DIR, `${id}.ndjson`), ndjson);

  meta[id] = {
    lastEditDate,
    fetchedAt: new Date().toISOString().slice(0, 10),
    count: records.length,
  };
  return true;
}

async function main() {
  // Allow targeting a single source: npm run fetch -- denver
  const target = process.argv[2];
  const sources = target ? SOURCES.filter(s => s.id === target) : SOURCES;
  if (target && sources.length === 0) {
    console.error(`Unknown source: ${target}. Valid: ${SOURCES.map(s => s.id).join(', ')}`);
    process.exit(1);
  }

  mkdirSync(join(ROOT, 'data'), { recursive: true });
  const meta = loadMeta();
  let anyUpdated = false;

  for (const source of sources) {
    try {
      const updated = await fetchSource(source, meta);
      if (updated) anyUpdated = true;
    } catch (err) {
      console.error(`  ERROR: ${err.message}`);
      process.exitCode = 1;
    }
    saveMeta(meta); // save after each source so progress isn't lost on error
  }

  console.log(anyUpdated
    ? '\nFetch complete. Run `npm run build` to rebuild the map.'
    : '\nAll sources up to date.');
}

main().catch(err => { console.error(err); process.exit(1); });

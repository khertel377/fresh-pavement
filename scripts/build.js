#!/usr/bin/env node
// Merge normalized NDJSON files into public/data/segments.geojson.
// Run: npm run build
//
// Reads data/normalized/{denver,aurora,lakewood}.ndjson
// Computes band/skate_score/basis/confidence for each record,
// flattens schema to GeoJSON properties, writes public/data/segments.geojson.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { computeBand } from './lib/score.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NORMALIZED_DIR = join(ROOT, 'data/normalized');
const META_FILE = join(ROOT, 'data/.meta.json');
const OUT_FILE = join(ROOT, 'public/data/segments.geojson');

const SOURCES = ['denver', 'aurora', 'lakewood'];

function readNDJSON(file) {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(l => l.trim())
    .map(l => JSON.parse(l));
}

function loadMeta() {
  return existsSync(META_FILE) ? JSON.parse(readFileSync(META_FILE, 'utf8')) : {};
}

// Flatten normalized record + scoring to GeoJSON feature properties.
function toProperties(record, fetchedAt, scoring) {
  const lt = record.last_treatment;
  const pl = record.planned;
  const ci = record.condition;
  const ex = record.extra || {};
  return {
    id:          record.id,
    source:      record.source,
    name:        record.name || '',
    from:        record.from || '',
    to:          record.to || '',
    lt_type:     lt?.type  ?? null,
    lt_year:     lt?.year  ?? null,
    pl_type:     pl?.type  ?? null,
    pl_year:     pl?.year  ?? null,
    ci_score:    ci?.score ?? null,
    ci_iri:      ci?.iri   ?? null,
    ci_date:     ci?.date  ?? null,
    cond_label:  ci?.raw   ?? null,
    band:        scoring?.band        ?? null,
    skate_score: scoring?.skate_score ?? null,
    basis:       scoring?.basis       ?? null,
    confidence:  scoring?.confidence  ?? null,
    morat_year:  ex.moratorium_year   ?? null,
    crew:        ex.crew              ?? null,
    tx_comment:  ex.treatment_comment ?? null,
    run_date:    fetchedAt || null,
  };
}

function bandDistribution(records) {
  const dist = {};
  for (const r of records) {
    const s = computeBand(r);
    const key = s?.band ?? 'unscored';
    dist[key] = (dist[key] || 0) + 1;
  }
  return dist;
}

function printDistribution(sourceId, dist, total) {
  const ORDER = ['fresh', 'excellent', 'good', 'fair', 'poor', 'very_poor', 'failed', 'unscored'];
  const lines = ORDER
    .filter(b => dist[b])
    .map(b => {
      const pct = ((dist[b] / total) * 100).toFixed(1);
      const flag = dist[b] / total > 0.60 ? ' ⚠ >60%' : '';
      return `    ${b.padEnd(12)} ${String(dist[b]).padStart(6)} (${pct}%)${flag}`;
    });
  console.log(`  [${sourceId}]`);
  lines.forEach(l => console.log(l));
}

function main() {
  const meta = loadMeta();
  const features = [];
  let fid = 0;

  console.log('Building segments.geojson…');
  for (const sourceId of SOURCES) {
    const file = join(NORMALIZED_DIR, `${sourceId}.ndjson`);
    if (!existsSync(file)) {
      console.warn(`  Warning: ${file} not found — skipping. Run \`npm run fetch\` first.`);
      continue;
    }

    const records = readNDJSON(file);
    const fetchedAt = meta[sourceId]?.fetchedAt || new Date().toISOString().slice(0, 10);

    for (const record of records) {
      const scoring = computeBand(record);
      features.push({
        type: 'Feature',
        id: ++fid,
        geometry: record.geometry,
        properties: toProperties(record, fetchedAt, scoring),
      });
    }

    console.log(`  ${sourceId}: ${records.length.toLocaleString()} segments`);
  }

  const fc = { type: 'FeatureCollection', features };
  mkdirSync(join(ROOT, 'public/data'), { recursive: true });
  writeFileSync(OUT_FILE, JSON.stringify(fc));

  const mb = (Buffer.byteLength(JSON.stringify(fc)) / 1024 / 1024).toFixed(1);
  console.log(`\nWrote public/data/segments.geojson`);
  console.log(`  ${features.length.toLocaleString()} total segments, ~${mb} MB uncompressed`);
  console.log('  (Vercel / GitHub Pages serves with gzip automatically)');

  // Band distribution report — printed on every build so it's in the commit/Actions log
  console.log('\nBand distribution:');
  for (const sourceId of SOURCES) {
    const file = join(NORMALIZED_DIR, `${sourceId}.ndjson`);
    if (!existsSync(file)) continue;
    const records = readNDJSON(file);
    const dist = bandDistribution(records);
    printDistribution(sourceId, dist, records.length);
  }
}

main();

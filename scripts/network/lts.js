#!/usr/bin/env node
// Compute Level of Traffic Stress (LTS 1–4) for each conflated edge.
// Also resolves pavement band from the best matched pavement record.
// Run: npm run network:lts
//
// Input:  data/network/edges-matched.ndjson  (from conflate)
// Output: data/network/edges-lts.ndjson      (flat edges with lts, band, facility_type, …)
//
// LTS model: Furth/Mekuria segment approach.
// Rules live in config/lts.json — no thresholds hardcoded here.

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { computeBand } from '../lib/score.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const cfg  = JSON.parse(readFileSync(join(ROOT, 'config/lts.json'), 'utf8'));

const {
  highway_speed_defaults: SPEED_DEFAULTS,
  highway_lane_defaults:  LANE_DEFAULTS,
  lts1_facility_types:    LTS1_FAC,
  lts1_highway_types:     LTS1_HWY,
  mixed_traffic_rules:    MIXED_RULES,
  painted_lane_rules:     PAINTED_RULES,
  buffered_lane_rules:    BUFFERED_RULES,
} = cfg;

// ---------------------------------------------------------------------------
// Speed parsing
// ---------------------------------------------------------------------------

function parseOsmSpeed(tag) {
  if (!tag) return null;
  const s = tag.trim().toLowerCase();
  if (s === 'walk') return 10;
  if (s === 'bicycle') return 15;
  const mphM = s.match(/^(\d+(?:\.\d+)?)\s*mph?$/);
  if (mphM) return Math.round(+mphM[1]);
  const kphM = s.match(/^(\d+(?:\.\d+)?)\s*(?:km\/h|kph)$/);
  if (kphM) return Math.round(+kphM[1] * 0.621371);
  const numM = s.match(/^(\d+(?:\.\d+)?)$/);
  if (numM) return Math.round(+numM[1]);
  return null;
}

// ---------------------------------------------------------------------------
// Lane parsing
// ---------------------------------------------------------------------------

function parseOsmLanes(tags) {
  const fwd = tags['lanes:forward'];
  const bwd = tags['lanes:backward'];
  if (fwd || bwd) {
    const f = fwd ? +fwd : 0;
    const b = bwd ? +bwd : 0;
    if (f + b > 0) return f + b;
  }
  if (tags.lanes) {
    const n = +tags.lanes;
    if (n > 0) return n;
  }
  return null;
}

// ---------------------------------------------------------------------------
// OSM cycleway tag → facility type
// ---------------------------------------------------------------------------

const CYCLEWAY_TO_FAC = {
  track:          'protected_lane',
  lane:           'painted_lane',
  buffered_lane:  'buffered_lane',
  share_busway:   'painted_lane',
  opposite_lane:  'painted_lane',
  opposite:       'painted_lane',
  shared_lane:    'sharrow',
  crossing:       null,
  no:             null,
  none:           null,
};

function osmFacilityType(tags) {
  const hw = tags.highway || '';
  if (hw === 'cycleway') return 'protected_lane';
  if (hw === 'path') return 'shared_use_path';
  if (hw === 'living_street') return 'neighborhood_bikeway';

  for (const key of ['cycleway:both', 'cycleway:right', 'cycleway:left', 'cycleway']) {
    const val = tags[key];
    if (val && CYCLEWAY_TO_FAC[val] !== undefined) {
      return CYCLEWAY_TO_FAC[val];
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// LTS rule evaluation
// ---------------------------------------------------------------------------

function applyRules(rules, speed, lanes) {
  for (const rule of rules) {
    if (rule.comment) continue;
    if (speed <= rule.max_speed && lanes <= rule.max_lanes) return rule.lts;
  }
  const last = rules[rules.length - 1];
  return last.lts ?? 4;
}

function computeLTS(edge) {
  const tags    = edge.tags    || {};
  const highway = tags.highway || '';

  const osmSpeed = parseOsmSpeed(tags.maxspeed);
  const speed = osmSpeed ?? edge.speed_mph ?? SPEED_DEFAULTS[highway] ?? 35;

  const osmLanes = parseOsmLanes(tags);
  const lanes = osmLanes ?? LANE_DEFAULTS[highway] ?? 2;

  const conflatedFac  = edge.facility?.type ?? null;
  const osmFac        = osmFacilityType(tags);
  const facility_type = conflatedFac ?? osmFac;

  if (LTS1_HWY.includes(highway)) {
    return { lts: 1, speed, lanes, facility_type };
  }
  if (facility_type && LTS1_FAC.includes(facility_type)) {
    return { lts: 1, speed, lanes, facility_type };
  }

  if (facility_type === 'buffered_lane') {
    return { lts: applyRules(BUFFERED_RULES, speed, lanes), speed, lanes, facility_type };
  }

  if (facility_type === 'painted_lane' || facility_type === 'sharrow' || facility_type === 'sidepath') {
    return { lts: applyRules(PAINTED_RULES, speed, lanes), speed, lanes, facility_type };
  }

  // Mixed traffic — check highway class constraint
  for (const rule of MIXED_RULES) {
    if (rule.comment) continue;
    const classOk = rule.highway_classes.includes('*') || rule.highway_classes.includes(highway);
    if (speed <= rule.max_speed && lanes <= rule.max_lanes && classOk) {
      return { lts: rule.lts, speed, lanes, facility_type };
    }
  }

  return { lts: 4, speed, lanes, facility_type };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function readNDJSON(file) {
  return readFileSync(file, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
}

function main() {
  const inFile  = join(ROOT, 'data/network/edges-matched.ndjson');
  const outFile = join(ROOT, 'data/network/edges-lts.ndjson');

  if (!existsSync(inFile)) {
    throw new Error(`${inFile} not found. Run: npm run network:conflate`);
  }

  console.log('Loading edges-matched…');
  const edges = readNDJSON(inFile);
  console.log(`  ${edges.length.toLocaleString()} edges`);

  const dist    = { 1: 0, 2: 0, 3: 0, 4: 0 };
  const facDist = {};
  const bandDist = {};

  const lines = edges.map(edge => {
    const { lts, speed, lanes, facility_type } = computeLTS(edge);

    // Resolve pavement band from conflated best_record
    const bestRecord = edge.pavement?.best_record ?? null;
    const scoring = bestRecord ? computeBand(bestRecord) : null;
    const band       = scoring?.band       ?? null;
    const skate_score= scoring?.skate_score ?? null;
    const pave_basis = scoring?.basis       ?? null;
    const pave_src   = bestRecord?.source   ?? null;

    dist[lts]++;
    if (facility_type) facDist[facility_type] = (facDist[facility_type] || 0) + 1;
    if (band) bandDist[band] = (bandDist[band] || 0) + 1;

    const tags = edge.tags || {};

    // GeoJSON Feature format — required by tippecanoe
    return JSON.stringify({
      type: 'Feature',
      geometry: edge.geometry,
      properties: {
        id:            edge.id,
        way_id:        edge.way_id,
        highway:       tags.highway   ?? null,
        name:          tags.name      ?? null,
        lts,
        speed_mph:     speed,
        lanes,
        facility_type: facility_type ?? null,
        band,
        skate_score,
        pave_basis,
        pave_src,
      },
    });
  });

  writeFileSync(outFile, lines.join('\n') + '\n');
  console.log(`\nWrote ${edges.length.toLocaleString()} edges to edges-lts.ndjson`);

  const total = edges.length;
  console.log('\nLTS distribution:');
  for (const lts of [1, 2, 3, 4]) {
    const n = dist[lts] || 0;
    const pct = (n / total * 100).toFixed(1);
    const bar = '█'.repeat(Math.round(n / total * 30));
    console.log(`  LTS ${lts}: ${n.toLocaleString().padStart(7)} (${pct.padStart(5)}%)  ${bar}`);
  }

  if (Object.keys(facDist).length) {
    console.log('\nFacility types:');
    for (const [fac, n] of Object.entries(facDist).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${fac.padEnd(22)} ${n.toLocaleString()}`);
    }
  }

  if (Object.keys(bandDist).length) {
    console.log('\nPavement bands (edges with matched data):');
    const BAND_ORDER = ['fresh', 'excellent', 'good', 'fair', 'poor', 'very_poor', 'failed'];
    for (const b of BAND_ORDER) {
      if (bandDist[b]) console.log(`  ${b.padEnd(12)} ${bandDist[b].toLocaleString()}`);
    }
  }

  const lts1pct = dist[1] / total;
  const lts4pct = dist[4] / total;
  if (lts1pct < 0.05) console.warn(`  ⚠ LTS 1 is only ${(lts1pct*100).toFixed(1)}% — check facility conflation`);
  if (lts4pct > 0.50) console.warn(`  ⚠ LTS 4 is ${(lts4pct*100).toFixed(1)}% — very high; check speed defaults`);

  console.log('\nRun: npm run network:build-tiles');
}

main();

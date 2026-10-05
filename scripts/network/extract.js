#!/usr/bin/env node
// Clip the Colorado PBF to the metro bbox, filter to highway ways, export to OPL.
// Run: npm run network:extract
//
// Prerequisites: osmium-tool  →  brew install osmium-tool
// Outputs:
//   data/osm/metro.osm.pbf    clipped to metro bbox
//   data/osm/streets.osm.pbf  highway ways only (relevant tags kept)
//   data/osm/streets.opl      OPL text format (nodes + ways, ready for build-edges)

import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';

const ROOT    = join(dirname(fileURLToPath(import.meta.url)), '../..');
const OSM_DIR = join(ROOT, 'data/osm');
const PBF_IN  = join(OSM_DIR, 'colorado-latest.osm.pbf');
const METRO   = join(OSM_DIR, 'metro.osm.pbf');
const STREETS = join(OSM_DIR, 'streets.osm.pbf');
const OPL     = join(OSM_DIR, 'streets.opl');

const cfg  = JSON.parse(readFileSync(join(ROOT, 'config/lts.json'), 'utf8'));
const bbox = cfg.metro_bbox; // [west, south, east, north]

function run(cmd) {
  console.log(`  $ ${cmd}`);
  execSync(cmd, { stdio: 'inherit' });
}

function checkOsmium() {
  try { execSync('osmium version', { stdio: 'pipe' }); }
  catch { throw new Error('osmium-tool not found. Install with: brew install osmium-tool'); }
}

function main() {
  checkOsmium();

  if (!existsSync(PBF_IN)) {
    throw new Error(`Colorado PBF not found: ${PBF_IN}\nRun: npm run network:download`);
  }

  // 1. Clip to metro bbox
  console.log('\nClipping to metro bbox…');
  run(`osmium extract --bbox="${bbox.join(',')}" "${PBF_IN}" -o "${METRO}" --overwrite`);

  // 2. Filter to highway=* ways (nodes are kept automatically as needed)
  console.log('\nFiltering to highway ways…');
  run(`osmium tags-filter "${METRO}" w/highway -o "${STREETS}" --overwrite`);

  // 3. Convert to OPL text format (preserves node IDs for edge splitting)
  // osmium cat converts between OSM formats; OPL gives us nodes+ways with tags
  console.log('\nConverting to OPL…');
  run(`osmium cat "${STREETS}" -o "${OPL}" --overwrite`);

  console.log(`\nDone. OPL written to ${OPL}`);
  console.log('Run: npm run network:build-edges');
}

main();

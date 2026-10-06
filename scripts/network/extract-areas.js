#!/usr/bin/env node
// Extract OSM area polygons needed for access context checks (golf courses, gardens, parks, etc.).
// Run: npm run network:extract-areas
//
// Prerequisites: osmium-tool  →  brew install osmium-tool
// Input:  data/osm/metro.osm.pbf   (from network:extract)
// Output: data/osm/areas.ndjson    (one GeoJSON Feature per line)
//
// Used by access.js to classify edges inside restricted areas (golf course → rideable=restricted)
// and to identify untagged footways inside parks (→ low-confidence path instead of no).

import { execSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync as rf } from 'fs';

const ROOT    = join(dirname(fileURLToPath(import.meta.url)), '../..');
const OSM_DIR = join(ROOT, 'data/osm');
const METRO   = join(OSM_DIR, 'metro.osm.pbf');
const AREAS_PBF = join(OSM_DIR, 'areas.osm.pbf');
const AREAS_OUT = join(OSM_DIR, 'areas.ndjson');

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

  if (!existsSync(METRO)) {
    throw new Error(`metro.osm.pbf not found at ${METRO}\nRun: npm run network:extract`);
  }

  // Filter to area features: restricted types + parks (for untagged footway context)
  // a/ prefix = area objects (closed ways + multipolygon relations)
  const areaFilter = [
    'a/leisure=golf_course',
    'a/leisure=garden',
    'a/leisure=stadium',
    'a/leisure=park',
    'a/leisure=nature_reserve',
    'a/landuse=cemetery',
    'a/landuse=military',
    'a/landuse=recreation_ground',
    'a/amenity=grave_yard',
    'a/amenity=prison',
    'a/tourism=zoo',
    'a/tourism=theme_park',
    'a/aeroway=aerodrome',
  ].join(' ');

  console.log('\nFiltering area features from metro PBF…');
  run(`osmium tags-filter "${METRO}" ${areaFilter} -o "${AREAS_PBF}" --overwrite`);

  console.log('\nExporting polygon geometries to NDJSON…');
  run(`osmium export "${AREAS_PBF}" --geometry-types=polygon -f geojsonseq -o "${AREAS_OUT}" --overwrite`);

  // Count output features (skip RS separator lines from GeoJSON text sequences format)
  const count = readFileSync(AREAS_OUT, 'utf8')
    .split('\n')
    .filter(l => l.trim() && !l.startsWith('\x1e'))
    .length;
  console.log(`\nExported ${count.toLocaleString()} area polygons → ${AREAS_OUT}`);
  console.log('Run: npm run network:access');
}

main();

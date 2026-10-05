#!/usr/bin/env node
// Convert edges-lts.ndjson → public/tiles/network.pmtiles via tippecanoe.
// Run: npm run network:build-tiles
//
// Prerequisites: tippecanoe  →  brew install tippecanoe
// Output: public/tiles/network.pmtiles

import { execSync } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT  = join(dirname(fileURLToPath(import.meta.url)), '..');
const IN    = join(ROOT, 'data/network/edges-lts.ndjson');
const TILES = join(ROOT, 'public/tiles');
const OUT   = join(TILES, 'network.pmtiles');

function checkTippecanoe() {
  try { execSync('tippecanoe --version', { stdio: 'pipe' }); }
  catch { throw new Error('tippecanoe not found. Install with: brew install tippecanoe'); }
}

function main() {
  checkTippecanoe();

  if (!existsSync(IN)) {
    throw new Error(`${IN} not found. Run: npm run network:lts`);
  }

  mkdirSync(TILES, { recursive: true });

  // tippecanoe flags:
  //   -Z 8 / -z 14     zoom 8–14 gives ~10 m resolution at max zoom
  //   -l network        single layer
  //   --drop-smallest-at-each-zoom  thin crowded tiles at low zoom
  //   --simplification 2  gentle geometry simplification at low zoom
  //   --no-tile-size-limit  don't drop features if tiles get large
  //   --force           overwrite existing output
  const cmd = [
    'tippecanoe',
    `--output="${OUT}"`,
    '--force',
    '--layer=network',
    '--minimum-zoom=8',
    '--maximum-zoom=14',
    '--drop-smallest-as-needed',
    '--simplification=2',
    '--no-tile-size-limit',
    `"${IN}"`,
  ].join(' ');

  console.log('Running tippecanoe…');
  console.log(`  $ ${cmd}`);
  execSync(cmd, { stdio: 'inherit' });

  console.log(`\nWrote: ${OUT}`);
  console.log('Run: npm run build  (or open public/index.html to preview)');
}

main();

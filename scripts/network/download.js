#!/usr/bin/env node
// Download the Geofabrik Colorado OSM extract, caching it for 30 days.
// Run: npm run network:download
//
// Prerequisites: none (pure Node.js fetch + streams).
// Output: data/osm/colorado-latest.osm.pbf

import { createWriteStream, existsSync, readFileSync, writeFileSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT    = join(dirname(fileURLToPath(import.meta.url)), '../..');
const OSM_DIR = join(ROOT, 'data/osm');
const PBF     = join(OSM_DIR, 'colorado-latest.osm.pbf');
const STAMP   = join(OSM_DIR, '.last-download');
const URL     = 'https://download.geofabrik.de/north-america/us/colorado-latest.osm.pbf';
const MAX_AGE_DAYS = 30;

async function main() {
  // Check cache age
  if (existsSync(STAMP) && existsSync(PBF)) {
    const ageMs = Date.now() - new Date(readFileSync(STAMP, 'utf8').trim()).getTime();
    const ageDays = ageMs / (1000 * 60 * 60 * 24);
    if (ageDays < MAX_AGE_DAYS) {
      const sizeMB = (statSync(PBF).size / 1024 / 1024).toFixed(0);
      console.log(`Colorado PBF is ${ageDays.toFixed(0)} days old (${sizeMB} MB) — skipping download.`);
      console.log(`Delete ${STAMP} to force a fresh download.`);
      return;
    }
  }

  console.log(`Downloading ${URL}`);
  console.log('(~250 MB — takes a minute or two)');

  const res = await fetch(URL);
  if (!res.ok) throw new Error(`HTTP ${res.status} from Geofabrik`);

  const total = +(res.headers.get('content-length') || 0);
  let received = 0;
  const out = createWriteStream(PBF);

  for await (const chunk of res.body) {
    out.write(chunk);
    received += chunk.length;
    if (total) {
      const pct = ((received / total) * 100).toFixed(0);
      process.stdout.write(`\r  ${(received / 1024 / 1024).toFixed(0)} / ${(total / 1024 / 1024).toFixed(0)} MB  (${pct}%)   `);
    }
  }
  out.end();

  await new Promise((resolve, reject) => { out.on('finish', resolve); out.on('error', reject); });
  process.stdout.write('\n');

  writeFileSync(STAMP, new Date().toISOString() + '\n');
  console.log(`Saved to ${PBF}`);
}

main().catch(err => { console.error(err); process.exit(1); });

#!/usr/bin/env node
// Spot-checks and distribution report for LTS scores.
// Run: npm run check-lts
//
// Spot checks: known corridors with expected LTS values.
// Distribution: per-highway-class LTS breakdown.

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------
// Spot checks: { name, highway_name_fragment, expected_lts, note }
// ---------------------------------------------------------------------------
const SPOT_CHECKS = [
  { desc: 'E Colfax Ave (arterial, no lane)',        name: /colfax/i,           max_lts: 4, exact_lts: 4, note: 'high speed/lanes — LTS 4' },
  { desc: 'W Speer Blvd (arterial)',                 name: /speer/i,            max_lts: 4, exact_lts: 4, note: 'high speed — LTS 4' },
  { desc: 'Broadway protected bike lane',            name: /broadway/i,         max_lts: 2, note: 'protected or buffered lane segments should be ≤ LTS 2' },
  { desc: 'Cherry Creek Trail (shared-use path)',    name: /cherry creek/i,     max_lts: 1, note: 'shared_use_path → LTS 1' },
  { desc: 'Washington Park area (residential)',      name: /s humboldt|s.grant/i, max_lts: 2, note: 'calm residential ≤ LTS 2' },
];

function readNDJSON(file) {
  return readFileSync(file, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
}

function main() {
  const ltsFile = join(ROOT, 'data/network/edges-lts.ndjson');
  if (!existsSync(ltsFile)) {
    console.error('edges-lts.ndjson not found. Run: npm run network:lts');
    process.exit(1);
  }

  console.log('Loading edges-lts…');
  const edges = readNDJSON(ltsFile);
  console.log(`  ${edges.length.toLocaleString()} edges\n`);

  // --- Spot checks ---
  console.log('=== Spot Checks ===');
  let pass = 0, fail = 0, warn = 0;

  for (const check of SPOT_CHECKS) {
    const matches = edges.filter(e => check.name.test(e.tags?.name || ''));
    if (matches.length === 0) {
      console.log(`  ⚠ SKIP  ${check.desc} — no edges found matching ${check.name}`);
      warn++;
      continue;
    }

    const ltsCounts = {};
    for (const e of matches) ltsCounts[e.lts] = (ltsCounts[e.lts] || 0) + 1;
    const dominant = +Object.entries(ltsCounts).sort((a,b) => b[1]-a[1])[0][0];
    const sample   = matches[0];

    const ok = check.exact_lts != null
      ? dominant === check.exact_lts
      : dominant <= check.max_lts;

    const icon = ok ? '✓ PASS' : '✗ FAIL';
    const expectStr = check.exact_lts != null
      ? `expected LTS=${check.exact_lts}`
      : `expected LTS≤${check.max_lts}`;

    const distStr = Object.entries(ltsCounts)
      .sort((a,b) => +a[0] - +b[0])
      .map(([k,v]) => `LTS${k}×${v}`)
      .join(' ');

    console.log(`  ${icon}  ${check.desc}`);
    console.log(`         ${expectStr}, dominant=LTS${dominant}  [${distStr}]`);
    console.log(`         ${check.note}`);
    if (!ok) {
      console.log(`         sample edge: id=${sample.id}, speed=${sample.speed_mph}, lanes=${sample.lanes}, fac=${sample.facility_type}`);
    }
    console.log();

    ok ? pass++ : fail++;
  }

  console.log(`Spot checks: ${pass} passed, ${fail} failed, ${warn} skipped\n`);

  // --- Distribution by highway class ---
  console.log('=== LTS Distribution by Highway Class ===');
  const byClass = {};
  for (const e of edges) {
    const hw = e.tags?.highway || 'unknown';
    if (!byClass[hw]) byClass[hw] = { 1: 0, 2: 0, 3: 0, 4: 0, total: 0 };
    byClass[hw][e.lts] = (byClass[hw][e.lts] || 0) + 1;
    byClass[hw].total++;
  }

  const classOrder = ['residential', 'secondary', 'tertiary', 'primary', 'unclassified',
                       'service', 'cycleway', 'path', 'living_street'];
  const displayed = new Set();

  for (const hw of classOrder) {
    if (!byClass[hw]) continue;
    displayed.add(hw);
    printClassRow(hw, byClass[hw]);
  }
  for (const [hw, d] of Object.entries(byClass)) {
    if (!displayed.has(hw)) printClassRow(hw, d);
  }

  // --- Overall distribution ---
  console.log('\n=== Overall LTS Distribution ===');
  const overall = { 1: 0, 2: 0, 3: 0, 4: 0, total: edges.length };
  for (const e of edges) overall[e.lts]++;
  printClassRow('ALL', overall);

  // --- Facility type breakdown ---
  console.log('\n=== Facility Types ===');
  const facDist = {};
  for (const e of edges) {
    const f = e.facility_type || '(none)';
    facDist[f] = (facDist[f] || 0) + 1;
  }
  for (const [fac, n] of Object.entries(facDist).sort((a,b) => b[1]-a[1])) {
    const pct = (n / edges.length * 100).toFixed(1);
    console.log(`  ${fac.padEnd(25)} ${n.toLocaleString().padStart(7)} (${pct}%)`);
  }

  if (fail > 0) process.exit(1);
}

function printClassRow(hw, d) {
  const total = d.total;
  const pcts  = [1,2,3,4].map(l => ((d[l]||0)/total*100).toFixed(0).padStart(3) + '%');
  console.log(`  ${hw.padEnd(18)} total=${total.toLocaleString().padStart(7)}  LTS1=${pcts[0]} LTS2=${pcts[1]} LTS3=${pcts[2]} LTS4=${pcts[3]}`);
}

main();

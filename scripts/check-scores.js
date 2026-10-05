#!/usr/bin/env node
// Score verification: unit tests, distribution report, calibration check.
// Run: npm run check-scores
//
// Exits with code 1 if any tests fail or calibration has mismatches.

import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { computeBand } from './lib/score.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCES = ['denver', 'aurora', 'lakewood'];
const BAND_ORDER = ['fresh', 'excellent', 'good', 'fair', 'poor', 'very_poor', 'failed'];

let testsFailed = 0;

// ---------------------------------------------------------------------------
// Tiny test runner
// ---------------------------------------------------------------------------
function assert(desc, actual, expected) {
  if (actual !== expected) {
    console.error(`  FAIL: ${desc}`);
    console.error(`    expected: ${JSON.stringify(expected)}`);
    console.error(`    actual:   ${JSON.stringify(actual)}`);
    testsFailed++;
  } else {
    console.log(`  pass: ${desc}`);
  }
}

function assertBandAtMost(desc, actual, maxBand) {
  // "at most maxBand" = index >= BAND_ORDER.indexOf(maxBand) (equal or worse)
  if (actual == null) {
    console.error(`  FAIL: ${desc} — got null`);
    testsFailed++;
    return;
  }
  const actualI = BAND_ORDER.indexOf(actual);
  const maxI = BAND_ORDER.indexOf(maxBand);
  if (actualI < maxI) {
    console.error(`  FAIL: ${desc}`);
    console.error(`    expected at most "${maxBand}" but got "${actual}" (better)`);
    testsFailed++;
  } else {
    console.log(`  pass: ${desc}`);
  }
}

function makeRecord(overrides) {
  return {
    source: 'test',
    last_treatment: null,
    planned: null,
    condition: null,
    geometry: null,
    extra: {},
    ...overrides,
  };
}

function runTests() {
  console.log('\n--- Unit tests ---');

  // Fresh mill & overlay (age 0) → fresh
  assert(
    'mill_overlay age 0 → fresh',
    computeBand(makeRecord({ last_treatment: { type: 'mill_overlay', year: new Date().getFullYear() } }))?.band,
    'fresh'
  );

  // HIPR age 0 → excellent (Franklin St reference)
  assert(
    'hipr age 0 → excellent',
    computeBand(makeRecord({ last_treatment: { type: 'hipr', year: new Date().getFullYear() } }))?.band,
    'excellent'
  );

  // Chip seal: can never score better than poor
  const chipNew = computeBand(makeRecord({ last_treatment: { type: 'chip_seal', year: new Date().getFullYear() } }));
  assertBandAtMost('chip_seal age 0 ≤ poor', chipNew?.band, 'poor');

  const chipOld = computeBand(makeRecord({ last_treatment: { type: 'chip_seal', year: new Date().getFullYear() - 10 } }));
  assertBandAtMost('chip_seal age 10 ≤ poor', chipOld?.band, 'poor');

  // IRI = -1 should not score 100 (should be unscored or use PCI only)
  const auroraMissingIRI = computeBand(makeRecord({
    source: 'aurora',
    condition: { index: 'PCI', raw: null, score: null, iri: -1 },
    extra: { iri_category: '#N/A', pci_category: null },
  }));
  assert('aurora IRI=-1 → unscored', auroraMissingIRI, null);

  // Missing PCI and bad IRI → unscored
  const auroraNoData = computeBand(makeRecord({
    source: 'aurora',
    condition: { index: 'PCI', raw: null, score: null, iri: null },
    extra: { iri_category: null },
  }));
  assert('aurora null PCI + null IRI → unscored', auroraNoData, null);

  // crack_seal / reclamite fall through to condition
  const crackWithCondition = computeBand(makeRecord({
    last_treatment: { type: 'crack_seal', year: new Date().getFullYear() },
    condition: { index: 'PCI', raw: 60, score: 60, iri: null },
    extra: {},
  }));
  assert('crack_seal falls through to PCI 60 → fair', crackWithCondition?.band, 'fair');

  // Condition only — PCI 90 → excellent
  assert(
    'PCI 90 → excellent',
    computeBand(makeRecord({ condition: { index: 'PCI', raw: 90, score: 90, iri: null }, extra: {} }))?.band,
    'excellent'
  );

  // PCI 30 → very_poor
  assert(
    'PCI 30 → very_poor',
    computeBand(makeRecord({ condition: { index: 'PCI', raw: 30, score: 30, iri: null }, extra: {} }))?.band,
    'very_poor'
  );

  // Aurora IRI_Category "Very Poor" → very_poor
  assert(
    'aurora IRI_Category "Very Poor" → very_poor',
    computeBand(makeRecord({
      source: 'aurora',
      condition: { index: 'PCI', raw: null, score: null, iri: null },
      extra: { iri_category: 'Very Poor' },
    }))?.band,
    'very_poor'
  );

  console.log(`\n  ${testsFailed === 0 ? 'All tests passed.' : `${testsFailed} test(s) FAILED.`}`);
}

// ---------------------------------------------------------------------------
// Distribution report
// ---------------------------------------------------------------------------
function readNDJSON(file) {
  return readFileSync(file, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
}

function distributionReport() {
  console.log('\n--- Band distribution ---');
  for (const sourceId of SOURCES) {
    const file = join(ROOT, 'data/normalized', `${sourceId}.ndjson`);
    if (!existsSync(file)) { console.log(`  [${sourceId}] no data — run npm run fetch`); continue; }

    const records = readNDJSON(file);
    const dist = {};
    for (const r of records) {
      const s = computeBand(r);
      const key = s?.band ?? 'unscored';
      dist[key] = (dist[key] || 0) + 1;
    }

    const total = records.length;
    console.log(`  [${sourceId}] ${total.toLocaleString()} segments`);
    for (const b of [...BAND_ORDER, 'unscored']) {
      if (!dist[b]) continue;
      const pct = ((dist[b] / total) * 100).toFixed(1);
      const flag = dist[b] / total > 0.60 ? '  ⚠ >60% in one band' : '';
      console.log(`    ${b.padEnd(12)} ${String(dist[b]).padStart(6)}  (${pct.padStart(5)}%)${flag}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Calibration check
// ---------------------------------------------------------------------------
function calibrationCheck() {
  const calFile = join(ROOT, 'config/calibration.json');
  if (!existsSync(calFile)) return;
  const { streets } = JSON.parse(readFileSync(calFile, 'utf8'));
  if (!streets?.length) return;

  console.log('\n--- Calibration check ---');
  let matches = 0, mismatches = 0;

  for (const entry of streets) {
    const file = join(ROOT, 'data/normalized', `${entry.source}.ndjson`);
    if (!existsSync(file)) { console.log(`  skip: ${entry.source} data not fetched`); continue; }

    const records = readNDJSON(file);
    const nameUp = entry.name.toUpperCase();
    const fromUp = (entry.from || '').toUpperCase();
    const toUp   = (entry.to   || '').toUpperCase();

    const match = records.find(r =>
      r.name?.toUpperCase().includes(nameUp) &&
      (!fromUp || r.from?.toUpperCase().includes(fromUp) || r.to?.toUpperCase().includes(fromUp)) &&
      (!toUp   || r.to?.toUpperCase().includes(toUp)     || r.from?.toUpperCase().includes(toUp))
    );

    if (!match) {
      console.log(`  not found: ${entry.source} "${entry.name}" ${entry.from}–${entry.to}`);
      continue;
    }

    const scoring = computeBand(match);
    const predicted = scoring?.band ?? 'unscored';
    const ok = predicted === entry.rider_band;
    if (ok) { matches++; console.log(`  match:    ${entry.name} → ${predicted}`); }
    else    { mismatches++; console.log(`  MISMATCH: ${entry.name} → predicted=${predicted}, rider=${entry.rider_band}`); }
    if (entry.note) console.log(`            (${entry.note})`);
  }

  console.log(`\n  ${matches} match, ${mismatches} mismatch`);
  if (mismatches > 0) testsFailed += mismatches;
}

// ---------------------------------------------------------------------------
// TODO: Border seam check
// ---------------------------------------------------------------------------
// For segments within ~500 m of a city boundary, compare band distributions
// on each side. Needs coordinate-based spatial filtering.
// Placeholder: print a reminder.
function borderSeamNote() {
  console.log('\n--- Border seam check ---');
  console.log('  TODO: spatial 500 m buffer check (needs segment centroids).');
  console.log('  Visual check: zoom to the Denver–Aurora and Denver–Lakewood borders');
  console.log('  on the map and confirm there is no obvious color jump.');
}

// ---------------------------------------------------------------------------
runTests();
distributionReport();
calibrationCheck();
borderSeamNote();

if (testsFailed > 0) {
  console.error(`\n${testsFailed} failure(s). Exiting 1.`);
  process.exit(1);
}

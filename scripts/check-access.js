#!/usr/bin/env node
// Spot-checks for access classification (rideable, car_free, ride_class).
// Run: npm run check-access
//
// Reads edges-lts.ndjson (final computed values after access + lts steps).
// Each edge is a GeoJSON Feature; properties are at e.properties.xxx.

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Spot checks: name regex → expected properties on the dominant matching edge.
// All fields are checked against e.properties.xxx.
const CHECKS = [
  // Bbox checks: zero rideable=yes path/footway/cycleway edges inside restricted area bboxes
  // pathOnly:true excludes surrounding streets (motor roads) from the count — we only care
  // about non-motorized paths that might slip through polygon-based restriction.
  {
    // Some perimeter/through paths may remain rideable=yes; threshold allows ≤20% to pass.
    desc:          'Denver Botanic Gardens — mostly non-rideable paths inside bbox',
    bbox:          [-104.9625, 39.7270, -104.9565, 39.7320],  // approx. E 13th/York area
    bboxCheck:     true,
    pathOnly:      true,
    maxRideablePct: 0.20,
    note:          'access=customers paths + polygon context → majority restricted or no',
  },
  {
    desc:          'City Park Golf Course — mostly non-rideable paths inside bbox',
    bbox:          [-104.9555, 39.7405, -104.9440, 39.7500],  // north City Park
    bboxCheck:     true,
    pathOnly:      true,
    maxRideablePct: 0.20,
    note:          'golf=* tags + leisure=golf_course polygon → majority rideable=no/restricted',
  },
  {
    desc:    'Cheesman Park Road — car-free, path family, LTS 1, high confidence',
    name:    /cheesman park/i,
    expect:  { car_free: true, ride_class: 'path', lts: 1, confidence: 'high' },
    note:    'motor_vehicle=no + bicycle=designated → car-free override',
  },
  {
    desc:    'Cherry Creek Trail — rideable path',
    name:    /cherry creek/i,
    expect:  { rideable: 'yes', ride_class: 'path', lts: 1 },
    note:    'shared_use_path / highway=path → path, LTS 1',
  },
  {
    // "City Park" matches many interior park roads, not just the designated bike route.
    // Verify roads are rideable with a reasonable class; dominant may be calm for unnamed roads.
    desc:    'City Park Road — rideable (name matches many park roads)',
    name:    /city park/i,
    expect:  { rideable: 'yes', ride_class: ['bikeway', 'path', 'calm'] },
    note:    'bicycle=designated segments → bikeway; other park roads → calm; all should be rideable',
  },
  {
    desc:    'Denver Botanic Gardens paths — restricted (access=customers)',
    access_reason: /customers/i,
    expect:  { rideable: 'restricted' },
    note:    'access=customers on interior paths → restricted',
  },
  {
    desc:    'Golf cart paths — not rideable (golf=cartpath or bicycle=no)',
    access_reason: /golf/i,
    expect:  { rideable: 'no' },
    note:    'golf=* → no',
  },
];

function readNDJSON(file) {
  return readFileSync(file, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
}

function checkField(actual, expected) {
  if (Array.isArray(expected)) return expected.includes(actual);
  return actual === expected;
}

function main() {
  const ltsFile = join(ROOT, 'data/network/edges-lts.ndjson');
  if (!existsSync(ltsFile)) {
    console.error('edges-lts.ndjson not found. Run: npm run network:lts');
    process.exit(1);
  }

  console.log('Loading edges-lts…');
  const features = readNDJSON(ltsFile);
  console.log(`  ${features.length.toLocaleString()} edges\n`);

  let pass = 0, fail = 0, skip = 0;

  for (const check of CHECKS) {
    // Bbox check: count rideable=yes edges whose midpoint falls inside the bbox
    if (check.bboxCheck) {
      const PATH_TYPES = new Set(['path','footway','cycleway','track','bridleway']);
      const [minLon, minLat, maxLon, maxLat] = check.bbox;
      let inside = features.filter(f => {
        const coords = f.geometry?.coordinates;
        if (!coords?.length) return false;
        const [lon, lat] = coords[Math.floor(coords.length / 2)];
        return lon >= minLon && lon <= maxLon && lat >= minLat && lat <= maxLat;
      });
      if (check.pathOnly) {
        inside = inside.filter(f => PATH_TYPES.has(f.properties?.highway));
      }
      if (inside.length === 0) {
        console.log(`  ⚠ SKIP  ${check.desc}`);
        const hint = check.pathOnly ? 'No path/footway/cycleway edges in bbox' : 'No edges in bbox';
        console.log(`         ${hint} — needs network rebuild with extract-areas\n`);
        skip++;
        continue;
      }
      const yesCount = inside.filter(f => (f.properties?.rideable ?? 'yes') === 'yes').length;
      const yesPct = yesCount / inside.length;
      const ok = check.maxRideablePct != null
        ? yesPct <= check.maxRideablePct
        : yesCount === 0;
      const pathNote = check.pathOnly ? ' (path/footway/cycleway only)' : '';
      const threshold = check.maxRideablePct != null ? ` (threshold ≤${(check.maxRideablePct*100).toFixed(0)}%)` : '';
      console.log(`  ${ok ? '✓ PASS' : '✗ FAIL'}  ${check.desc}`);
      console.log(`         ${inside.length} edges in bbox${pathNote}: rideable=yes ${yesCount} (${(yesPct*100).toFixed(1)}%)${threshold}, restricted ${inside.filter(f=>f.properties?.rideable==='restricted').length}, no ${inside.filter(f=>f.properties?.rideable==='no').length}`);
      console.log(`         ${check.note}\n`);
      ok ? pass++ : fail++;
      continue;
    }

    let matches;
    if (check.name) {
      matches = features.filter(f => check.name.test(f.properties?.name || ''));
    } else if (check.access_reason) {
      matches = features.filter(f => check.access_reason.test(f.properties?.access_reason || ''));
    } else {
      matches = [];
    }

    if (matches.length === 0) {
      console.log(`  ⚠ SKIP  ${check.desc}`);
      console.log(`         No edges found — needs network data built with access step\n`);
      skip++;
      continue;
    }

    // Use the most common value across matches for each expected field
    const fieldResults = {};
    for (const [field, expected] of Object.entries(check.expect)) {
      const counts = {};
      for (const f of matches) counts[f.properties[field]] = (counts[f.properties[field]] || 0) + 1;
      const dominant = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
      // Object.entries() coerces all keys to strings; restore booleans and numbers.
      const expectedVal = Array.isArray(expected) ? expected[0] : expected;
      const dominantCoerced = dominant === 'true' ? true
        : dominant === 'false' ? false
        : (typeof expectedVal === 'number' && !isNaN(Number(dominant))) ? Number(dominant)
        : dominant;
      fieldResults[field] = { dominant: dominantCoerced, ok: checkField(dominantCoerced, expected), counts };
    }

    const allOk = Object.values(fieldResults).every(r => r.ok);
    const icon  = allOk ? '✓ PASS' : '✗ FAIL';
    console.log(`  ${icon}  ${check.desc}`);
    for (const [field, r] of Object.entries(fieldResults)) {
      const exp = Array.isArray(check.expect[field]) ? check.expect[field].join('|') : check.expect[field];
      const status = r.ok ? '✓' : '✗';
      const dist = Object.entries(r.counts).map(([v,n]) => `${v}×${n}`).join(' ');
      console.log(`         ${status} ${field}: expected=${exp}, dominant=${r.dominant}  [${dist}]`);
    }
    console.log(`         ${check.note}`);
    if (!allOk) {
      const sample = matches[0].properties;
      console.log(`         sample: name="${sample.name}" highway=${sample.highway} access_reason="${sample.access_reason}" ride_class=${sample.ride_class}`);
    }
    console.log();
    allOk ? pass++ : fail++;
  }

  console.log(`Access checks: ${pass} passed, ${fail} failed, ${skip} skipped\n`);

  // Distribution report
  console.log('=== Rideable Distribution ===');
  const rideableDist = {}, carFreeDist = { true: 0, false: 0 };
  for (const f of features) {
    const r = f.properties.rideable ?? 'yes';
    rideableDist[r] = (rideableDist[r] || 0) + 1;
    if (f.properties.car_free) carFreeDist.true++;
    else carFreeDist.false++;
  }
  const total = features.length;
  for (const [k, n] of Object.entries(rideableDist)) {
    console.log(`  ${k.padEnd(12)}: ${n.toLocaleString().padStart(7)} (${(n/total*100).toFixed(1)}%)`);
  }
  console.log(`  car_free     : ${carFreeDist.true.toLocaleString().padStart(7)} (${(carFreeDist.true/total*100).toFixed(1)}%)`);

  console.log('\n=== Top Access Reasons ===');
  const reasonDist = {};
  for (const f of features) {
    if (f.properties.access_reason) {
      const r = f.properties.access_reason;
      reasonDist[r] = (reasonDist[r] || 0) + 1;
    }
  }
  for (const [r, n] of Object.entries(reasonDist).sort((a, b) => b[1] - a[1]).slice(0, 15)) {
    console.log(`  ${r.padEnd(35)} ${n.toLocaleString()}`);
  }

  if (fail > 0) process.exit(1);
}

main();

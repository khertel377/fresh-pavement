#!/usr/bin/env node
// Classify each edge as rideable=yes|restricted|no and detect car-free roads.
// Run: npm run network:access
//
// Input:  data/network/edges-matched.ndjson  (from conflate)
// Output: data/network/edges-access.ndjson   (same edges + rideable, car_free, access_reason)
//
// Rule priority (first match wins):
//   1. bicycle=no|dismount                 → rideable=no
//   2. golf=* on the way                   → rideable=no  (cart path / golf way)
//   3. non-rideable highway/footway/service → rideable=no
//   4. access=private|customers|etc        → rideable=restricted  (unless bicycle=yes|designated)
//   5. motor_vehicle=no / car-free highway → car_free=true, ride_class=path, lts=1
//   6. bicycle=designated on a road        → flag for lts.js to upgrade to bikeway
//
// Polygon-based restricted area detection (leisure=golf_course, etc.) requires
// data/osm/areas.ndjson from npm run network:extract-areas (not yet implemented).
// Way-level tags already cover the common test cases (Cheesman, Botanic Gardens, golf).

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const cfg  = JSON.parse(readFileSync(join(ROOT, 'config/access.json'), 'utf8'));

const NOT_RIDE_BICYCLE  = new Set(cfg.not_rideable_bicycle);
const NOT_RIDE_HIGHWAY  = new Set(cfg.not_rideable_highway);
const NOT_RIDE_FOOTWAY  = new Set(cfg.not_rideable_footway);
const NOT_RIDE_SERVICE  = new Set(cfg.not_rideable_service);
const NOT_RIDE_ACCESS   = new Set(cfg.not_rideable_access);
const BIKE_OVERRIDE     = new Set(cfg.bicycle_override_access);
const CAR_FREE_MV       = new Set(cfg.car_free_motor_vehicle);
const CAR_FREE_VEH      = new Set(cfg.car_free_vehicle);
const CAR_FREE_HWY      = new Set(cfg.car_free_highway);

const ACCESS_LABELS = {
  private:      'Private access',
  customers:    'Customers only',
  no:           'No public access',
  delivery:     'Delivery only',
  agricultural: 'Agricultural access',
  forestry:     'Forestry access',
};

function classifyAccess(edge) {
  const tags    = edge.tags || {};
  const highway = tags.highway   || '';
  const bicycle = tags.bicycle   || '';
  const access  = tags.access    || '';
  const golf    = tags.golf      || '';
  const footway = tags.footway   || '';
  const service = tags.service   || '';
  const mv      = tags.motor_vehicle || tags.motorcar || tags.vehicle || '';

  // 1. Explicit bicycle prohibition
  if (NOT_RIDE_BICYCLE.has(bicycle)) {
    return { rideable: 'no', car_free: false,
      access_reason: bicycle === 'dismount' ? 'Dismount zone' : 'No cycling' };
  }

  // 2. Golf tag → always a cart path or golf course feature
  if (golf) {
    return { rideable: 'no', car_free: false, access_reason: 'Golf path' };
  }

  // 3. Non-rideable infrastructure type
  if (NOT_RIDE_HIGHWAY.has(highway)) {
    return { rideable: 'no', car_free: false, access_reason: `highway=${highway}` };
  }
  if (footway && NOT_RIDE_FOOTWAY.has(footway)) {
    return { rideable: 'no', car_free: false,
      access_reason: footway === 'sidewalk' ? 'Sidewalk' : 'Crossing' };
  }
  if (service && NOT_RIDE_SERVICE.has(service)) {
    return { rideable: 'no', car_free: false, access_reason: `service=${service}` };
  }

  // 4. Restricted access — unless bicycle is explicitly allowed
  if (access && NOT_RIDE_ACCESS.has(access) && !BIKE_OVERRIDE.has(bicycle)) {
    return { rideable: 'restricted', car_free: false,
      access_reason: ACCESS_LABELS[access] || `access=${access}` };
  }

  // 5. Car-free detection
  let car_free = false;
  let access_reason = null;
  if (CAR_FREE_MV.has(mv) || CAR_FREE_VEH.has(mv)) {
    car_free = true;
    access_reason = 'Closed to cars';
  } else if (CAR_FREE_HWY.has(highway)) {
    // path/cycleway/track are inherently car-free
    car_free = true;
    access_reason = highway === 'cycleway' ? 'Cycleway' : null;
  } else if ((highway === 'pedestrian' || highway === 'footway') && BIKE_OVERRIDE.has(bicycle)) {
    car_free = true;
    access_reason = 'Pedestrian way, bikes allowed';
  }

  return { rideable: 'yes', car_free, access_reason };
}

function main() {
  const inFile  = join(ROOT, 'data/network/edges-matched.ndjson');
  const outFile = join(ROOT, 'data/network/edges-access.ndjson');

  if (!existsSync(inFile)) {
    throw new Error(`${inFile} not found. Run: npm run network:conflate`);
  }

  const edges = readFileSync(inFile, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
  console.log(`Loaded ${edges.length.toLocaleString()} edges from edges-matched.ndjson`);

  const dist = { yes: 0, restricted: 0, no: 0 };
  let carFreeCount = 0;
  const reasonDist = {};

  const lines = edges.map(edge => {
    const { rideable, car_free, access_reason } = classifyAccess(edge);
    dist[rideable]++;
    if (car_free) carFreeCount++;
    if (access_reason) reasonDist[access_reason] = (reasonDist[access_reason] || 0) + 1;
    return JSON.stringify({ ...edge, rideable, car_free, access_reason: access_reason ?? null });
  });

  writeFileSync(outFile, lines.join('\n') + '\n');
  console.log(`Wrote ${edges.length.toLocaleString()} edges to edges-access.ndjson\n`);

  const total = edges.length;
  console.log('Rideable distribution:');
  for (const [k, n] of Object.entries(dist)) {
    const pct = (n / total * 100).toFixed(1);
    console.log(`  ${k.padEnd(12)}: ${n.toLocaleString().padStart(7)} (${pct}%)`);
  }
  console.log(`  car_free     : ${carFreeCount.toLocaleString().padStart(7)} (${(carFreeCount/total*100).toFixed(1)}%)`);

  if (Object.keys(reasonDist).length) {
    console.log('\nTop access reasons:');
    for (const [r, n] of Object.entries(reasonDist).sort((a, b) => b[1] - a[1]).slice(0, 12)) {
      console.log(`  ${r.padEnd(32)} ${n.toLocaleString()}`);
    }
  }

  const noPct = dist.no / total;
  if (noPct > 0.30) console.warn(`  ⚠ ${(noPct*100).toFixed(1)}% of edges are rideable=no — rules may be too broad`);

  console.log('\nRun: npm run network:lts');
}

main();

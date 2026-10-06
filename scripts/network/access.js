#!/usr/bin/env node
// Classify each edge as rideable=yes|restricted|no and detect car-free roads.
// Run: npm run network:access
//
// Input:  data/network/edges-matched.ndjson  (from conflate)
// Output: data/network/edges-access.ndjson   (same edges + rideable, car_free, access_reason, access_note)
//
// Rule priority (first match wins):
//   1. bicycle=no|dismount                        → rideable=no
//   2. golf=* on the way                          → rideable=no
//   3. non-rideable highway type                  → rideable=no
//   4. footway=sidewalk|crossing                  → rideable=no
//   5. service=driveway|parking_aisle             → rideable=no
//   6. access=private|customers|etc               → rideable=restricted (unless bicycle=yes|designated)
//   7. highway=pedestrian (no bike access)        → rideable=no
//   8. highway=footway (no bicycle tag):
//        inside park polygon                      → rideable=yes, car_free, confidence=low, access_note=untagged
//        else                                     → rideable=no (likely sidewalk)
//   9. Inside restricted area polygon (golf etc.) → rideable=restricted (unless bicycle override)
//  10. Car-free detection: motor_vehicle=no / car-free highway types → car_free=true
//
// Polygon checks require data/osm/areas.ndjson from npm run network:extract-areas.
// If that file is absent, polygon rules are skipped (way-level tags cover the common test cases).

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import Flatbush from 'flatbush';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const cfg  = JSON.parse(readFileSync(join(ROOT, 'config/access.json'), 'utf8'));

const NOT_RIDE_BICYCLE = new Set(cfg.not_rideable_bicycle);
const NOT_RIDE_HIGHWAY = new Set(cfg.not_rideable_highway);
const NOT_RIDE_FOOTWAY = new Set(cfg.not_rideable_footway);
const NOT_RIDE_SERVICE = new Set(cfg.not_rideable_service);
const NOT_RIDE_ACCESS  = new Set(cfg.not_rideable_access);
const BIKE_OVERRIDE    = new Set(cfg.bicycle_override_access);
const CAR_FREE_MV      = new Set(cfg.car_free_motor_vehicle);
const CAR_FREE_VEH     = new Set(cfg.car_free_vehicle);
const CAR_FREE_HWY     = new Set(cfg.car_free_highway);
const PARK_TAGS        = new Set((cfg.park_area_tags || []).map(t => `${t.key}=${t.value}`));

const ACCESS_LABELS = {
  private: 'Private access', customers: 'Customers only', no: 'No public access',
  delivery: 'Delivery only', agricultural: 'Agricultural access', forestry: 'Forestry access',
};

// ---------------------------------------------------------------------------
// Polygon helpers
// ---------------------------------------------------------------------------

function geoBbox(geom) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const rings = geom.type === 'MultiPolygon' ? geom.coordinates.flatMap(p => p) : geom.coordinates;
  for (const ring of rings) {
    for (const [x, y] of ring) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  return [minX, minY, maxX, maxY];
}

function raycast(px, py, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi))
      inside = !inside;
  }
  return inside;
}

function pointInGeom(point, geom) {
  const [px, py] = point;
  const polys = geom.type === 'MultiPolygon' ? geom.coordinates : [geom.coordinates];
  return polys.some(poly => raycast(px, py, poly[0]));
}

function edgeMidpoint(geom) {
  const c = geom.coordinates;
  return c[Math.floor(c.length / 2)];
}

// ---------------------------------------------------------------------------
// Area classification
// ---------------------------------------------------------------------------

function getRestrictedAreaName(props) {
  // garden: only restricted if access≠yes (or fee=yes)
  if (props.leisure === 'garden') {
    if (props.access === 'yes' && !props.fee) return null;
    return props.name || 'Garden';
  }
  for (const t of cfg.restricted_area_tags) {
    if (props[t.key] === t.value) return props.name || `${t.key}=${t.value}`;
  }
  return null;
}

function isParkProp(props) {
  const key = `${props.leisure ? 'leisure' : props.landuse ? 'landuse' : ''}`;
  const val = props.leisure || props.landuse || '';
  return PARK_TAGS.has(`${key}=${val}`);
}

// ---------------------------------------------------------------------------
// Load polygon index from areas.ndjson (optional)
// ---------------------------------------------------------------------------

function loadAreaIndex() {
  const areasFile = join(ROOT, 'data/osm/areas.ndjson');
  if (!existsSync(areasFile)) return { index: null, areas: [] };

  const areas = readFileSync(areasFile, 'utf8')
    .split('\n')
    .filter(l => l.trim() && !l.startsWith('\x1e'))
    .map(l => { try { return JSON.parse(l.replace(/^\x1e/, '')); } catch { return null; } })
    .filter(f => f?.geometry?.type === 'Polygon' || f?.geometry?.type === 'MultiPolygon');

  if (areas.length === 0) return { index: null, areas: [] };

  const index = new Flatbush(areas.length);
  for (const area of areas) {
    const [x1, y1, x2, y2] = geoBbox(area.geometry);
    index.add(x1, y1, x2, y2);
  }
  index.finish();

  console.log(`  Loaded ${areas.length.toLocaleString()} area polygons for context checks`);
  return { index, areas };
}

function queryArea(point, index, areas, predicate) {
  if (!index) return null;
  const [px, py] = point;
  for (const ci of index.search(px, py, px, py)) {
    const area = areas[ci];
    if (predicate(area.properties) && pointInGeom(point, area.geometry)) return area;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main classification
// ---------------------------------------------------------------------------

function classifyAccess(edge, areaIndex, areas) {
  const tags    = edge.tags || {};
  const highway = tags.highway   || '';
  const bicycle = tags.bicycle   || '';
  const access  = tags.access    || '';
  const golf    = tags.golf      || '';
  const footway = tags.footway   || '';
  const service = tags.service   || '';
  const mv      = tags.motor_vehicle || tags.motorcar || tags.vehicle || '';

  // 1. Explicit bicycle prohibition
  if (NOT_RIDE_BICYCLE.has(bicycle))
    return { rideable: 'no', car_free: false,
      access_reason: bicycle === 'dismount' ? 'Dismount zone' : 'No cycling' };

  // 2. Golf tag
  if (golf)
    return { rideable: 'no', car_free: false, access_reason: 'Golf path' };

  // 3. Non-rideable highway type (steps, corridor, elevator, bridleway)
  if (NOT_RIDE_HIGHWAY.has(highway))
    return { rideable: 'no', car_free: false, access_reason: `highway=${highway}` };

  // 4. Explicit sidewalk/crossing footway tag
  if (footway && NOT_RIDE_FOOTWAY.has(footway))
    return { rideable: 'no', car_free: false,
      access_reason: footway === 'sidewalk' ? 'Sidewalk' : 'Crossing' };

  // 5. Non-rideable service type
  if (service && NOT_RIDE_SERVICE.has(service))
    return { rideable: 'no', car_free: false, access_reason: `service=${service}` };

  // 6. Restricted access tag (unless bicycle is explicitly allowed)
  if (access && NOT_RIDE_ACCESS.has(access) && !BIKE_OVERRIDE.has(bicycle))
    return { rideable: 'restricted', car_free: false,
      access_reason: ACCESS_LABELS[access] || `access=${access}` };

  // 7. highway=pedestrian without explicit bike access
  if (highway === 'pedestrian' && !BIKE_OVERRIDE.has(bicycle))
    return { rideable: 'no', car_free: false, access_reason: 'Pedestrian zone' };

  // 8. highway=footway without bicycle tag: check park context
  if (highway === 'footway' && !bicycle) {
    const mid = edgeMidpoint(edge.geometry);
    const inPark = queryArea(mid, areaIndex, areas, isParkProp);
    if (inPark) {
      const parkName = inPark.properties.name || 'park';
      return { rideable: 'yes', car_free: true,
        access_reason: 'Bike access not tagged', access_note: 'untagged',
        context_area: parkName };
    }
    return { rideable: 'no', car_free: false, access_reason: 'Likely sidewalk' };
  }

  // 9. Polygon-based restricted area check
  if (areaIndex) {
    const mid = edgeMidpoint(edge.geometry);
    const restrictedArea = queryArea(mid, areaIndex, areas,
      props => getRestrictedAreaName(props) !== null);
    if (restrictedArea && !BIKE_OVERRIDE.has(bicycle)) {
      const areaName = getRestrictedAreaName(restrictedArea.properties);
      return { rideable: 'restricted', car_free: false,
        access_reason: `Inside ${areaName}`, context_area: areaName };
    }
  }

  // 10. Car-free detection
  let car_free = false, access_reason = null;
  if (CAR_FREE_MV.has(mv) || CAR_FREE_VEH.has(mv)) {
    car_free = true; access_reason = 'Closed to cars';
  } else if (CAR_FREE_HWY.has(highway)) {
    car_free = true; access_reason = highway === 'cycleway' ? 'Cycleway' : null;
  } else if ((highway === 'pedestrian' || highway === 'footway') && BIKE_OVERRIDE.has(bicycle)) {
    car_free = true; access_reason = 'Pedestrian way, bikes allowed';
  }

  return { rideable: 'yes', car_free, access_reason };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const inFile  = join(ROOT, 'data/network/edges-matched.ndjson');
  const outFile = join(ROOT, 'data/network/edges-access.ndjson');

  if (!existsSync(inFile)) {
    throw new Error(`${inFile} not found. Run: npm run network:conflate`);
  }

  console.log('Loading area polygon index…');
  const { index: areaIndex, areas } = loadAreaIndex();
  if (!areaIndex) console.log('  No areas.ndjson found — polygon rules skipped (run network:extract-areas to enable)');

  const edges = readFileSync(inFile, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
  console.log(`Loaded ${edges.length.toLocaleString()} edges from edges-matched.ndjson`);

  const dist = { yes: 0, restricted: 0, no: 0 };
  let carFreeCount = 0, untaggedCount = 0;
  const reasonDist = {};

  const lines = edges.map(edge => {
    const result = classifyAccess(edge, areaIndex, areas);
    const { rideable, car_free, access_reason, access_note = null, context_area = null } = result;
    dist[rideable]++;
    if (car_free) carFreeCount++;
    if (access_note === 'untagged') untaggedCount++;
    if (access_reason) reasonDist[access_reason] = (reasonDist[access_reason] || 0) + 1;
    return JSON.stringify({ ...edge, rideable, car_free, access_reason: access_reason ?? null,
      access_note, context_area });
  });

  writeFileSync(outFile, lines.join('\n') + '\n');
  console.log(`\nWrote ${edges.length.toLocaleString()} edges to edges-access.ndjson`);

  const total = edges.length;
  console.log('\nRideable distribution:');
  for (const [k, n] of Object.entries(dist)) {
    console.log(`  ${k.padEnd(12)}: ${n.toLocaleString().padStart(7)} (${(n/total*100).toFixed(1)}%)`);
  }
  console.log(`  car_free     : ${carFreeCount.toLocaleString().padStart(7)} (${(carFreeCount/total*100).toFixed(1)}%)`);
  if (untaggedCount) console.log(`  untagged park: ${untaggedCount.toLocaleString().padStart(7)} (${(untaggedCount/total*100).toFixed(1)}%) [low confidence]`);

  if (Object.keys(reasonDist).length) {
    console.log('\nTop access reasons:');
    for (const [r, n] of Object.entries(reasonDist).sort((a, b) => b[1] - a[1]).slice(0, 12))
      console.log(`  ${r.padEnd(35)} ${n.toLocaleString()}`);
  }

  const noPct = dist.no / total;
  if (noPct > 0.35) console.warn(`  ⚠ ${(noPct*100).toFixed(1)}% of edges are rideable=no — rules may be too broad`);

  console.log('\nRun: npm run network:lts');
}

main();

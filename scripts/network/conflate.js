#!/usr/bin/env node
// Conflate pavement bands, bike facilities and speed limits onto OSM edges.
// Run: npm run network:conflate
//
// Inputs:
//   data/network/edges.ndjson        (from build-edges)
//   data/normalized/*.ndjson         (pavement: denver, aurora, lakewood)
//   data/normalized/bike_*.ndjson    (facilities: bike_denver, bike_drcog)
//   data/normalized/speed_drcog.ndjson
//
// Output:
//   data/network/edges-matched.ndjson (edges with band, facility, speed, source_ids)
//   data/network/match-report.json    (match rate per source, unmatched ids)
//
// Algorithm per source feature:
//   1. Expand bbox by MATCH_BUFFER_M → flatbush candidates
//   2. Name similarity check (if names present)
//   3. Bearing difference < BEARING_THRESHOLD_DEG
//   4. Overlap fraction (share of edge within buffer) ≥ OVERLAP_THRESHOLD
//   5. Assign to best candidate (highest overlap)

import Flatbush from 'flatbush';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

const MATCH_BUFFER_M       = 15;   // meters: candidate search radius
const BEARING_THRESHOLD    = 25;   // degrees: max heading difference
const OVERLAP_THRESHOLD    = 0.50; // fraction of edge length within buffer
const SAMPLE_INTERVAL_M    = 5;    // meters: edge sampling density for overlap

// ---------------------------------------------------------------------------
// Geometry helpers (no external dependencies)
// ---------------------------------------------------------------------------

const DEG_TO_RAD = Math.PI / 180;
const R_EARTH    = 6_371_000; // metres

function haversine([lon1, lat1], [lon2, lat2]) {
  const dLat = (lat2 - lat1) * DEG_TO_RAD;
  const dLon = (lon2 - lon1) * DEG_TO_RAD;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * DEG_TO_RAD) * Math.cos(lat2 * DEG_TO_RAD) * Math.sin(dLon / 2) ** 2;
  return R_EARTH * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function bearing([lon1, lat1], [lon2, lat2]) {
  const dLon = (lon2 - lon1) * DEG_TO_RAD;
  const y = Math.sin(dLon) * Math.cos(lat2 * DEG_TO_RAD);
  const x = Math.cos(lat1 * DEG_TO_RAD) * Math.sin(lat2 * DEG_TO_RAD)
    - Math.sin(lat1 * DEG_TO_RAD) * Math.cos(lat2 * DEG_TO_RAD) * Math.cos(dLon);
  return Math.atan2(y, x) * (180 / Math.PI);
}

function lineBearing(coords) {
  return bearing(coords[0], coords[coords.length - 1]);
}

function bearingDiff(b1, b2) {
  const d = Math.abs(b1 - b2) % 180;
  return d > 90 ? 180 - d : d;
}

function bboxOf(coords) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of coords) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY];
}

function lineLength(coords) {
  let len = 0;
  for (let i = 1; i < coords.length; i++) len += haversine(coords[i - 1], coords[i]);
  return len;
}

// Sample a linestring at fixed intervals, returning array of [lon,lat] points
function sampleLine(coords, intervalM = SAMPLE_INTERVAL_M) {
  const total = lineLength(coords);
  if (total === 0) return [coords[0]];
  const points = [coords[0]];
  let accumulated = 0;
  for (let i = 1; i < coords.length; i++) {
    const segLen = haversine(coords[i - 1], coords[i]);
    let d = 0;
    while (accumulated + d + intervalM <= accumulated + segLen) {
      d += intervalM;
      const frac = d / segLen;
      points.push([
        coords[i - 1][0] + frac * (coords[i][0] - coords[i - 1][0]),
        coords[i - 1][1] + frac * (coords[i][1] - coords[i - 1][1]),
      ]);
    }
    accumulated += segLen;
  }
  points.push(coords[coords.length - 1]);
  return points;
}

// Minimum distance from a point to a polyline
function pointToLineDistance(pt, lineCoords) {
  let minD = Infinity;
  for (let i = 1; i < lineCoords.length; i++) {
    const d = pointToSegmentDistance(pt, lineCoords[i - 1], lineCoords[i]);
    if (d < minD) minD = d;
  }
  return minD;
}

function pointToSegmentDistance(pt, a, b) {
  const ax = a[0], ay = a[1], bx = b[0], by = b[1], px = pt[0], py = pt[1];
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return haversine(pt, a);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return haversine(pt, [ax + t * dx, ay + t * dy]);
}

// What fraction of edgeCoords falls within bufferM of sourceCoords?
function overlapFraction(edgeCoords, sourceCoords, bufferM = MATCH_BUFFER_M) {
  const samples = sampleLine(edgeCoords);
  if (samples.length === 0) return 0;
  const within = samples.filter(p => pointToLineDistance(p, sourceCoords) <= bufferM);
  return within.length / samples.length;
}

// ---------------------------------------------------------------------------
// Street name normalization
// ---------------------------------------------------------------------------
const SUFFIX_MAP = {
  street: 'st', avenue: 'ave', boulevard: 'blvd', drive: 'dr',
  place: 'pl', court: 'ct', lane: 'ln', road: 'rd', way: 'wy',
  circle: 'cir', trail: 'trl', highway: 'hwy', parkway: 'pkwy',
};
const DIRECTIONALS = /\b(north|south|east|west|n\.?|s\.?|e\.?|w\.?)\s*/gi;

function normalizeName(name) {
  if (!name) return '';
  let s = name.toLowerCase().trim();
  s = s.replace(DIRECTIONALS, '');
  for (const [full, abbr] of Object.entries(SUFFIX_MAP)) {
    s = s.replace(new RegExp(`\\b${full}\\b`, 'g'), abbr);
  }
  return s.replace(/\s+/g, ' ').trim();
}

function namesCompatible(n1, n2) {
  if (!n1 || !n2) return true; // missing name = don't filter
  return normalizeName(n1) === normalizeName(n2);
}

// ---------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------
function readNDJSON(file) {
  return readFileSync(file, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
}

function getCoords(geom) {
  if (!geom) return [];
  if (geom.type === 'LineString') return geom.coordinates;
  if (geom.type === 'MultiLineString') return geom.coordinates.flat();
  return [];
}

// ---------------------------------------------------------------------------
// Spatial index
// ---------------------------------------------------------------------------
function buildIndex(edges) {
  const index = new Flatbush(edges.length);
  for (const edge of edges) {
    const [minX, minY, maxX, maxY] = bboxOf(getCoords(edge.geometry));
    index.add(minX, minY, maxX, maxY);
  }
  index.finish();
  return index;
}

// Buffer in degrees for a given radius in metres (approximate, good enough at lat 40)
function bufDeg(m) { return m / 111_000; }

// ---------------------------------------------------------------------------
// Match one source feature onto edges
// ---------------------------------------------------------------------------
function matchFeature(feature, edges, index, sourceName) {
  const srcCoords = getCoords(feature.geometry);
  if (srcCoords.length < 2) return null;

  const [minX, minY, maxX, maxY] = bboxOf(srcCoords);
  const bd = bufDeg(MATCH_BUFFER_M);
  const candidates = index.search(minX - bd, minY - bd, maxX + bd, maxY + bd);
  if (candidates.length === 0) return null;

  const srcBearing = lineBearing(srcCoords);
  const srcName    = feature.name || feature.street_name || null;

  let bestIdx = -1, bestOverlap = 0;

  for (const ci of candidates) {
    const edge = edges[ci];
    const edgeCoords = getCoords(edge.geometry);
    if (edgeCoords.length < 2) continue;

    // Name similarity
    if (!namesCompatible(srcName, edge.tags?.name)) continue;

    // Bearing
    const edgeBearing = lineBearing(edgeCoords);
    if (bearingDiff(srcBearing, edgeBearing) > BEARING_THRESHOLD) continue;

    // Overlap
    const overlap = overlapFraction(edgeCoords, srcCoords);
    if (overlap >= OVERLAP_THRESHOLD && overlap > bestOverlap) {
      bestOverlap = overlap;
      bestIdx = ci;
    }
  }

  return bestIdx === -1 ? null : { edgeIdx: bestIdx, overlap: bestOverlap };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const edgesFile = join(ROOT, 'data/network/edges.ndjson');
  if (!existsSync(edgesFile)) {
    throw new Error(`${edgesFile} not found. Run: npm run network:build-edges`);
  }

  console.log('Loading edges…');
  const edges = readNDJSON(edgesFile);
  console.log(`  ${edges.length.toLocaleString()} edges`);
  if (edges.length === 0) throw new Error('edges.ndjson is empty — check build-edges output');

  // Edge lookup maps: edgeIdx → accumulated data
  const edgeBands     = new Map(); // idx → { band, skate_score, source_ids }
  const edgeFacilities= new Map(); // idx → { facility, source, install_year, surface }
  const edgeSpeeds    = new Map(); // idx → speed_mph

  const report = {};

  console.log('\nBuilding spatial index…');
  const index = buildIndex(edges);

  // --- Pavement sources ---
  const PAVEMENT_SOURCES = ['denver', 'aurora', 'lakewood'];
  for (const src of PAVEMENT_SOURCES) {
    const file = join(ROOT, `data/normalized/${src}.ndjson`);
    if (!existsSync(file)) { console.log(`  [${src}] no data — skipping`); continue; }
    const records = readNDJSON(file);
    let matched = 0, unmatched = [];

    console.log(`\nConflating ${src} (${records.length.toLocaleString()} segments)…`);
    for (const rec of records) {
      const m = matchFeature(rec, edges, index, src);
      if (!m) { unmatched.push(rec.id); continue; }
      matched++;
      const { edgeIdx } = m;

      // Keep best (lowest index = better) band for this edge
      const existing = edgeBands.get(edgeIdx);
      const newBand  = rec.band; // will be null until we recompute — use lt_year/condition proxy
      // We match by geometry; band is on the NDJSON record (null until build step)
      // Store the record reference so build-tiles can recompute
      if (!existing || (rec.last_treatment?.year ?? 0) > (existing.best_year ?? 0)) {
        edgeBands.set(edgeIdx, {
          band:        null, // filled in by lts.js after scoring
          source_ids:  [...(existing?.source_ids ?? []), rec.id],
          best_record: rec,
          best_year:   rec.last_treatment?.year ?? 0,
        });
      } else {
        existing.source_ids.push(rec.id);
      }
    }

    const matchRate = records.length > 0 ? (matched / records.length * 100).toFixed(1) : '—';
    console.log(`  matched: ${matched.toLocaleString()} / ${records.length.toLocaleString()} (${matchRate}%)`);
    if (unmatched.length > 0) console.log(`  unmatched: ${unmatched.length} (first: ${unmatched[0]})`);

    report[src] = { total: records.length, matched, match_rate: +matchRate, unmatched_sample: unmatched.slice(0, 20) };
  }

  // --- Facility sources (priority: bike_denver > bike_drcog > OSM tags) ---
  const FACILITY_SOURCES = [
    { id: 'bike_denver', priority: 1 },
    { id: 'bike_drcog',  priority: 2 },
  ];
  for (const { id: src, priority } of FACILITY_SOURCES) {
    const file = join(ROOT, `data/normalized/${src}.ndjson`);
    if (!existsSync(file)) { console.log(`  [${src}] no data — skipping`); continue; }
    const records = readNDJSON(file);
    let matched = 0, unmatched = [];

    console.log(`\nConflating ${src} (${records.length.toLocaleString()} features)…`);
    for (const rec of records) {
      const m = matchFeature(rec, edges, index, src);
      if (!m) { unmatched.push(rec.id); continue; }
      matched++;
      const existing = edgeFacilities.get(m.edgeIdx);
      if (!existing || existing.priority > priority) {
        edgeFacilities.set(m.edgeIdx, { facility: rec.facility, source: src, install_year: rec.install_year, surface: rec.surface, priority });
      }
    }

    const matchRate = records.length > 0 ? (matched / records.length * 100).toFixed(1) : '—';
    console.log(`  matched: ${matched.toLocaleString()} / ${records.length.toLocaleString()} (${matchRate}%)`);
    report[src] = { total: records.length, matched, match_rate: +matchRate, unmatched_sample: unmatched.slice(0, 20) };
  }

  // --- Speed limits ---
  {
    const file = join(ROOT, 'data/normalized/speed_drcog.ndjson');
    if (existsSync(file)) {
      const records = readNDJSON(file);
      let matched = 0, unmatched = [];
      console.log(`\nConflating speed_drcog (${records.length.toLocaleString()} features)…`);
      for (const rec of records) {
        if (!rec.speed_mph) continue;
        const m = matchFeature(rec, edges, index, 'speed_drcog');
        if (!m) { unmatched.push(rec.id); continue; }
        matched++;
        if (!edgeSpeeds.has(m.edgeIdx)) edgeSpeeds.set(m.edgeIdx, rec.speed_mph);
      }
      const matchRate = records.length > 0 ? (matched / records.length * 100).toFixed(1) : '—';
      console.log(`  matched: ${matched.toLocaleString()} / ${records.length.toLocaleString()} (${matchRate}%)`);
      report['speed_drcog'] = { total: records.length, matched, match_rate: +matchRate, unmatched_sample: unmatched.slice(0, 20) };
    }
  }

  // --- Write output ---
  console.log('\nWriting edges-matched.ndjson…');
  const lines = edges.map((edge, idx) => {
    const pave = edgeBands.get(idx) ?? null;
    const fac  = edgeFacilities.get(idx) ?? null;
    const spd  = edgeSpeeds.get(idx) ?? null;
    return JSON.stringify({
      ...edge,
      pavement:  pave ? { source_ids: pave.source_ids, best_record: pave.best_record } : null,
      facility:  fac  ? { type: fac.facility, source: fac.source, install_year: fac.install_year, surface: fac.surface } : null,
      speed_mph: spd,
    });
  });
  writeFileSync(join(ROOT, 'data/network/edges-matched.ndjson'), lines.join('\n') + '\n');

  writeFileSync(join(ROOT, 'data/network/match-report.json'), JSON.stringify(report, null, 2) + '\n');

  console.log(`\nWrote ${edges.length.toLocaleString()} edges with match data.`);
  console.log('Match report: data/network/match-report.json');

  // Flag sources with low match rates
  for (const [src, r] of Object.entries(report)) {
    if (r.match_rate < 70) console.warn(`  ⚠ ${src}: low match rate ${r.match_rate}% — check name normalization and bbox`);
    if (r.match_rate >= 90) console.log(`  ✓ ${src}: ${r.match_rate}% match rate`);
  }

  console.log('\nRun: npm run network:access');
}

main().catch(err => { console.error(err); process.exit(1); });

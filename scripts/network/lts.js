#!/usr/bin/env node
// Compute Level of Traffic Stress (LTS 1–4) for each conflated edge.
// Also resolves pavement band, ride_class, surface, and confidence.
// Run: npm run network:lts
//
// Input:  data/network/edges-matched.ndjson  (from conflate)
// Output: data/network/edges-lts.ndjson      (flat edges with lts, band, facility_type, …)
//
// LTS model: Furth/Mekuria segment approach.
// Rules live in config/lts.json — no thresholds hardcoded here.

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { computeBand } from '../lib/score.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const cfg  = JSON.parse(readFileSync(join(ROOT, 'config/lts.json'), 'utf8'));

const {
  highway_speed_defaults: SPEED_DEFAULTS,
  highway_lane_defaults:  LANE_DEFAULTS,
  lts1_facility_types:    LTS1_FAC,
  lts1_highway_types:     LTS1_HWY,
  mixed_traffic_rules:    MIXED_RULES,
  painted_lane_rules:     PAINTED_RULES,
  buffered_lane_rules:    BUFFERED_RULES,
} = cfg;

// ---------------------------------------------------------------------------
// Speed parsing
// ---------------------------------------------------------------------------

function parseOsmSpeed(tag) {
  if (!tag) return null;
  const s = tag.trim().toLowerCase();
  if (s === 'walk') return 10;
  if (s === 'bicycle') return 15;
  const mphM = s.match(/^(\d+(?:\.\d+)?)\s*mph?$/);
  if (mphM) return Math.round(+mphM[1]);
  const kphM = s.match(/^(\d+(?:\.\d+)?)\s*(?:km\/h|kph)$/);
  if (kphM) return Math.round(+kphM[1] * 0.621371);
  const numM = s.match(/^(\d+(?:\.\d+)?)$/);
  if (numM) return Math.round(+numM[1]);
  return null;
}

// ---------------------------------------------------------------------------
// Lane parsing
// ---------------------------------------------------------------------------

function parseOsmLanes(tags) {
  const fwd = tags['lanes:forward'];
  const bwd = tags['lanes:backward'];
  if (fwd || bwd) {
    const f = fwd ? +fwd : 0;
    const b = bwd ? +bwd : 0;
    if (f + b > 0) return f + b;
  }
  if (tags.lanes) {
    const n = +tags.lanes;
    if (n > 0) return n;
  }
  return null;
}

// ---------------------------------------------------------------------------
// OSM cycleway tag → facility type
// ---------------------------------------------------------------------------

const CYCLEWAY_TO_FAC = {
  track:          'protected_lane',
  lane:           'painted_lane',
  buffered_lane:  'buffered_lane',
  share_busway:   'painted_lane',
  opposite_lane:  'painted_lane',
  opposite:       'painted_lane',
  shared_lane:    'sharrow',
  crossing:       null,
  no:             null,
  none:           null,
};

function osmFacilityType(tags) {
  const hw = tags.highway || '';
  if (hw === 'cycleway') return 'protected_lane';
  if (hw === 'path') return 'shared_use_path';
  if (hw === 'living_street') return 'neighborhood_bikeway';

  for (const key of ['cycleway:both', 'cycleway:right', 'cycleway:left', 'cycleway']) {
    const val = tags[key];
    if (val && CYCLEWAY_TO_FAC[val] !== undefined) {
      return CYCLEWAY_TO_FAC[val];
    }
  }
  // bicycle=designated on a road (no cycleway tag) → treat as neighborhood bikeway at minimum
  if (tags.bicycle === 'designated') return 'neighborhood_bikeway';
  return null;
}

// ---------------------------------------------------------------------------
// LTS rule evaluation
// ---------------------------------------------------------------------------

function applyRules(rules, speed, lanes) {
  for (const rule of rules) {
    if (rule.comment) continue;
    if (speed <= rule.max_speed && lanes <= rule.max_lanes) return rule.lts;
  }
  const last = rules[rules.length - 1];
  return last.lts ?? 4;
}

function computeLTS(edge) {
  const tags    = edge.tags    || {};
  const highway = tags.highway || '';

  const osmSpeed = parseOsmSpeed(tags.maxspeed);
  const drcogSpeed = edge.speed_mph ?? null;
  const speed = osmSpeed ?? drcogSpeed ?? SPEED_DEFAULTS[highway] ?? 35;
  const speed_src = osmSpeed != null ? 'osm' : drcogSpeed != null ? 'drcog' : 'default';

  const osmLanes = parseOsmLanes(tags);
  const lanes = osmLanes ?? LANE_DEFAULTS[highway] ?? 2;
  const lanes_src = osmLanes != null ? 'osm' : 'default';

  const conflatedFac  = edge.facility?.type ?? null;
  const conflatedFacSrc = edge.facility?.source ?? null;
  const osmFac        = osmFacilityType(tags);
  const facility_type = conflatedFac ?? osmFac;
  // 'city' if from bike_denver or bike_drcog; 'osm' if derived from OSM tags only
  const facility_src  = conflatedFacSrc ?? (osmFac ? 'osm' : null);

  // speed_affects_lts: false if highway type or LTS1 facility overrides speed entirely
  if (LTS1_HWY.includes(highway)) {
    return { lts: 1, speed, lanes, speed_src, lanes_src, facility_type, facility_src, speed_affects_lts: false };
  }
  if (facility_type && LTS1_FAC.includes(facility_type)) {
    return { lts: 1, speed, lanes, speed_src, lanes_src, facility_type, facility_src, speed_affects_lts: false };
  }

  if (facility_type === 'buffered_lane') {
    return { lts: applyRules(BUFFERED_RULES, speed, lanes), speed, lanes, speed_src, lanes_src, facility_type, facility_src, speed_affects_lts: true };
  }

  if (facility_type === 'painted_lane' || facility_type === 'sharrow' || facility_type === 'sidepath') {
    return { lts: applyRules(PAINTED_RULES, speed, lanes), speed, lanes, speed_src, lanes_src, facility_type, facility_src, speed_affects_lts: true };
  }

  // Mixed traffic — check highway class constraint
  for (const rule of MIXED_RULES) {
    if (rule.comment) continue;
    const classOk = rule.highway_classes.includes('*') || rule.highway_classes.includes(highway);
    if (speed <= rule.max_speed && lanes <= rule.max_lanes && classOk) {
      return { lts: rule.lts, speed, lanes, speed_src, lanes_src, facility_type, facility_src, speed_affects_lts: true };
    }
  }

  return { lts: 4, speed, lanes, speed_src, lanes_src, facility_type, facility_src, speed_affects_lts: true };
}

// ---------------------------------------------------------------------------
// ride_class: path | lane | bikeway | calm | busy | hostile
// ---------------------------------------------------------------------------

const FAC_TO_RIDE_CLASS = {
  shared_use_path:       'path',
  protected_lane:        'path',
  sidepath:              'path',
  buffered_lane:         'lane',
  painted_lane:          'lane',
  neighborhood_bikeway:  'bikeway',
  sharrow:               null,  // no real protection → falls through to LTS
};

function computeRideClass(facility_type, lts) {
  if (facility_type) {
    const cls = FAC_TO_RIDE_CLASS[facility_type];
    if (cls) return cls;
  }
  if (lts <= 2) return 'calm';
  if (lts === 3) return 'busy';
  return 'hostile';
}

// ---------------------------------------------------------------------------
// surface: fresh | smooth | fair | rough | none
// ---------------------------------------------------------------------------

function computeSurface(band) {
  if (!band) return 'none';
  if (band === 'fresh')                              return 'fresh';
  if (band === 'excellent' || band === 'good')       return 'smooth';
  if (band === 'fair')                               return 'fair';
  return 'rough';  // poor, very_poor, failed
}

// ---------------------------------------------------------------------------
// confidence: high | medium | low
// Combines LTS provenance and surface data quality.
// ---------------------------------------------------------------------------

const SURF_CONF = {
  treatment: 'high', iri: 'high',
  'pci+iri': 'medium', pci: 'medium', oci: 'medium',
  rating: 'low',
};
const CONF_RANK = { high: 2, medium: 1, low: 0 };

function computeConfidence(speed_src, lanes_src, facility_src, pave_basis, speed_affects_lts, speed) {
  // LTS confidence
  let lts_conf;
  if (!speed_affects_lts) {
    // Speed/lanes don't matter — confidence depends on how well we know the facility type
    if (facility_src === 'bike_denver') lts_conf = 'high';
    else lts_conf = 'medium'; // OSM infrastructure tags are reliable
  } else if (speed_src === 'default') {
    lts_conf = 'low'; // unknown speed — can't trust the LTS result
  } else if (lanes_src === 'default' && speed > 20) {
    lts_conf = 'low'; // lanes matter at this speed but unknown
  } else if (facility_src === 'osm') {
    lts_conf = 'medium';
  } else {
    lts_conf = 'high';
  }

  // Surface confidence (null if no pavement data)
  const surf_conf = pave_basis ? (SURF_CONF[pave_basis] ?? 'medium') : null;

  // Combined: lower of the two (surface null → use LTS confidence)
  if (!surf_conf) return lts_conf;
  return CONF_RANK[lts_conf] <= CONF_RANK[surf_conf] ? lts_conf : surf_conf;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function readNDJSON(file) {
  return readFileSync(file, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
}

function main() {
  const inFile  = join(ROOT, 'data/network/edges-access.ndjson');
  const outFile = join(ROOT, 'data/network/edges-lts.ndjson');

  if (!existsSync(inFile)) {
    throw new Error(`${inFile} not found. Run: npm run network:access`);
  }

  console.log('Loading edges-matched…');
  const edges = readNDJSON(inFile);
  console.log(`  ${edges.length.toLocaleString()} edges`);

  const ltsDist    = { 1: 0, 2: 0, 3: 0, 4: 0 };
  const facDist    = {};
  const bandDist   = {};
  const rideClsDist= {};
  const surfDist   = {};
  const confDist   = {};

  // Speed provenance tracking for report
  const speedSrcDist   = { osm: 0, drcog: 0, default: 0 };
  const hwSpeedDefault = {};  // highway → count of default-speed edges

  const lines = edges.map(edge => {
    const rideable      = edge.rideable      ?? 'yes';
    const car_free      = edge.car_free      ?? false;
    const access_reason = edge.access_reason ?? null;
    const access_note   = edge.access_note   ?? null;
    const context_area  = edge.context_area  ?? null;

    const ltsCmp = computeLTS(edge);
    const { speed, lanes, speed_src, lanes_src, facility_type, facility_src, speed_affects_lts } = ltsCmp;
    let lts = ltsCmp.lts;

    // Resolve pavement band from conflated best_record
    const bestRecord = edge.pavement?.best_record ?? null;
    const scoring = bestRecord ? computeBand(bestRecord) : null;
    const band       = scoring?.band       ?? null;
    const skate_score= scoring?.skate_score ?? null;
    const pave_basis = scoring?.basis       ?? null;
    const pave_src   = bestRecord?.source   ?? null;

    let ride_class = computeRideClass(facility_type, lts);
    const surface  = computeSurface(band);
    let confidence = computeConfidence(speed_src, lanes_src, facility_src, pave_basis, speed_affects_lts, speed);

    // Car-free overrides: these roads have no cars regardless of speed data
    if (car_free) {
      lts        = 1;
      ride_class  = 'path';
      // Untagged park footways: car-free but bicycle access was inferred, not confirmed
      confidence  = access_note === 'untagged' ? 'low' : 'high';
    }

    // Tracking
    ltsDist[lts]++;
    speedSrcDist[speed_src]++;
    if (speed_src === 'default') {
      const hw = (edge.tags?.highway) || 'unknown';
      hwSpeedDefault[hw] = (hwSpeedDefault[hw] || 0) + 1;
    }
    if (facility_type) facDist[facility_type] = (facDist[facility_type] || 0) + 1;
    if (band)          bandDist[band]         = (bandDist[band] || 0) + 1;
    rideClsDist[ride_class] = (rideClsDist[ride_class] || 0) + 1;
    surfDist[surface]       = (surfDist[surface] || 0) + 1;
    confDist[confidence]    = (confDist[confidence] || 0) + 1;

    const tags = edge.tags || {};

    // GeoJSON Feature format — required by tippecanoe
    return JSON.stringify({
      type: 'Feature',
      geometry: edge.geometry,
      properties: {
        id:            edge.id,
        way_id:        edge.way_id,
        highway:       tags.highway   ?? null,
        name:          tags.name      ?? null,
        lts,
        speed_mph:     speed,
        lanes,
        speed_src,
        facility_type: facility_type ?? null,
        facility_src:  facility_src  ?? null,
        ride_class,
        surface,
        confidence,
        band,
        skate_score,
        pave_basis,
        pave_src,
        rideable,
        car_free,
        access_reason,
        access_note,
        context_area,
      },
    });
  });

  writeFileSync(outFile, lines.join('\n') + '\n');
  console.log(`\nWrote ${edges.length.toLocaleString()} edges to edges-lts.ndjson`);

  const total = edges.length;

  // ── LTS distribution ──────────────────────────────────────────────────────
  console.log('\nLTS distribution:');
  for (const lts of [1, 2, 3, 4]) {
    const n = ltsDist[lts] || 0;
    const pct = (n / total * 100).toFixed(1);
    const bar = '█'.repeat(Math.round(n / total * 30));
    console.log(`  LTS ${lts}: ${n.toLocaleString().padStart(7)} (${pct.padStart(5)}%)  ${bar}`);
  }

  // ── Speed provenance report ───────────────────────────────────────────────
  console.log('\nSpeed provenance (LTS input quality):');
  for (const [src, n] of Object.entries(speedSrcDist)) {
    const pct = (n / total * 100).toFixed(1);
    console.log(`  ${src.padEnd(8)}: ${n.toLocaleString().padStart(7)} (${pct.padStart(5)}%)`);
  }
  console.log('\n  Top highway types using default speed:');
  const topDefaults = Object.entries(hwSpeedDefault).sort((a, b) => b[1] - a[1]).slice(0, 8);
  for (const [hw, n] of topDefaults) {
    console.log(`    ${hw.padEnd(20)} ${n.toLocaleString()}`);
  }

  // ── ride_class distribution ───────────────────────────────────────────────
  console.log('\nRide class distribution:');
  for (const [cls, n] of Object.entries(rideClsDist).sort((a, b) => b[1] - a[1])) {
    const pct = (n / total * 100).toFixed(1);
    console.log(`  ${cls.padEnd(10)}: ${n.toLocaleString().padStart(7)} (${pct.padStart(5)}%)`);
  }

  // ── Confidence distribution ───────────────────────────────────────────────
  console.log('\nConfidence distribution:');
  for (const conf of ['high', 'medium', 'low']) {
    const n = confDist[conf] || 0;
    const pct = (n / total * 100).toFixed(1);
    console.log(`  ${conf.padEnd(8)}: ${n.toLocaleString().padStart(7)} (${pct.padStart(5)}%)`);
  }

  if (Object.keys(facDist).length) {
    console.log('\nFacility types:');
    for (const [fac, n] of Object.entries(facDist).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${fac.padEnd(22)} ${n.toLocaleString()}`);
    }
  }

  if (Object.keys(bandDist).length) {
    console.log('\nPavement bands (edges with matched data):');
    const BAND_ORDER = ['fresh', 'excellent', 'good', 'fair', 'poor', 'very_poor', 'failed'];
    for (const b of BAND_ORDER) {
      if (bandDist[b]) console.log(`  ${b.padEnd(12)} ${bandDist[b].toLocaleString()}`);
    }
  }

  const lts1pct = ltsDist[1] / total;
  const lts4pct = ltsDist[4] / total;
  const defPct  = speedSrcDist.default / total;
  if (lts1pct < 0.05) console.warn(`  ⚠ LTS 1 is only ${(lts1pct*100).toFixed(1)}% — check facility conflation`);
  if (lts4pct > 0.50) console.warn(`  ⚠ LTS 4 is ${(lts4pct*100).toFixed(1)}% — very high; check speed defaults`);
  if (defPct > 0.60)  console.warn(`  ⚠ ${(defPct*100).toFixed(1)}% of edges use default speed — these render at low confidence`);

  console.log('\nRun: npm run network:build-tiles');
}

main();

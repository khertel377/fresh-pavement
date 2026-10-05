#!/usr/bin/env node
// Parse OPL output → split ways at intersections → write edges NDJSON.
// Run: npm run network:build-edges
//
// Input:  data/osm/streets.opl
// Output: data/network/edges.ndjson
//
// Edge id format: <wayId>:<fromNodeId>:<toNodeId>
// Each edge is one straight-ish segment between two intersection nodes.

import { createReadStream, createWriteStream, readFileSync } from 'fs';
import { createInterface } from 'readline';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT   = join(dirname(fileURLToPath(import.meta.url)), '../..');
const OPL    = join(ROOT, 'data/osm/streets.opl');
const OUTDIR = join(ROOT, 'data/network');
const OUT    = join(OUTDIR, 'edges.ndjson');

const cfg      = JSON.parse(readFileSync(join(ROOT, 'config/lts.json'), 'utf8'));
const DROP_HWY = new Set(cfg.drop_highway_types);
const DROP_SVC = new Set(cfg.drop_service_types);
const KEEP_TAGS = new Set(cfg.keep_tags);

// ---------------------------------------------------------------------------
// OPL parsing helpers
// ---------------------------------------------------------------------------

// Osmium OPL encodes special chars as %XX% (hex, WITH trailing %).
// E.g. space→%20%, comma→%2c%, equals→%3d%, percent→%25%.
// Regular printable ASCII is written as-is.
function decodeOPL(s) {
  return s.replace(/%([0-9a-fA-F]{2})%/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

// Parse "Ttag1=val1,tag2=val2,..." → { tag1: val1, ... }
function parseTags(tagStr) {
  if (!tagStr || tagStr === 'T') return {};
  const tags = {};
  // OPL escapes commas in values as \, and equals as \=
  // Simple split on unescaped commas
  const raw = tagStr.slice(1); // strip leading T
  // Values with literal commas are encoded as %2c% so a bare comma is always a tag separator
  for (const pair of raw.split(',')) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    const k = decodeOPL(pair.slice(0, eq));
    const v = decodeOPL(pair.slice(eq + 1));
    if (KEEP_TAGS.has(k)) tags[k] = v;
    else if (k === 'highway' || k === 'service') tags[k] = v; // always keep for filtering
  }
  return tags;
}

// Parse "Nn12345,n23456,..." → [12345, 23456, ...]
// OPL way node refs have a lowercase 'n' prefix per node ID.
function parseNodeRefs(nodeStr) {
  if (!nodeStr || nodeStr === 'N') return [];
  return nodeStr.slice(1).split(',').map(s => +s.trim().replace(/^n/, '')).filter(n => n > 0);
}

// ---------------------------------------------------------------------------
// Two-pass processing
// ---------------------------------------------------------------------------

async function readOPL(filePath, onNode, onWay) {
  const rl = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    const type = line[0];
    if (type === 'n') {
      // n<id> v... x<lon> y<lat> T...
      const xm = line.match(/\bx(-?[\d.]+)/);
      const ym = line.match(/\by(-?[\d.]+)/);
      const im = line.match(/^n(\d+)/);
      if (im && xm && ym) onNode(+im[1], +xm[1], +ym[1]);
    } else if (type === 'w') {
      // w<id> v... T<tags> N<nodes>
      const im = line.match(/^w(\d+)/);
      const tm = line.match(/\bT([^ ]*)/);
      const nm = line.match(/\bN([^ ]*)/);
      if (im && nm) {
        const tags = parseTags(tm ? tm[0] : '');
        const nodeRefs = parseNodeRefs(nm[0]);
        onWay(+im[1], tags, nodeRefs);
      }
    }
  }
}

async function main() {
  console.log('Pass 1: indexing nodes and counting way references…');
  const nodeCoords = new Map(); // nodeId → [lon, lat]
  const nodeWayCount = new Map(); // nodeId → count of ways that reference it

  // First: read nodes
  await readOPL(OPL,
    (id, lon, lat) => { nodeCoords.set(id, [lon, lat]); },
    () => {}
  );
  console.log(`  ${nodeCoords.size.toLocaleString()} nodes`);

  // Second: read ways to count node references (find intersections)
  const ways = [];
  await readOPL(OPL,
    () => {},
    (id, tags, nodeRefs) => {
      // Filter out unwanted highway types
      const hwType = tags.highway || '';
      if (DROP_HWY.has(hwType)) return;
      if (hwType === 'service' && DROP_SVC.has(tags.service || '')) return;
      if (!hwType) return;
      ways.push({ id, tags, nodeRefs });
      for (const nid of nodeRefs) {
        nodeWayCount.set(nid, (nodeWayCount.get(nid) || 0) + 1);
      }
    }
  );
  console.log(`  ${ways.length.toLocaleString()} ways after filtering`);

  // Nodes shared by 2+ ways are intersections (also way endpoints are always split points)
  const splitNodes = new Set();
  for (const [nid, count] of nodeWayCount) {
    if (count >= 2) splitNodes.add(nid);
  }
  // Way endpoints are always split points
  for (const way of ways) {
    if (way.nodeRefs.length > 0) {
      splitNodes.add(way.nodeRefs[0]);
      splitNodes.add(way.nodeRefs[way.nodeRefs.length - 1]);
    }
  }
  console.log(`  ${splitNodes.size.toLocaleString()} split nodes (intersections + endpoints)`);

  // Pass 2: split ways at split nodes → edges
  console.log('\nPass 2: splitting ways into edges…');
  const out = createWriteStream(OUT);
  let edgeCount = 0;

  for (const way of ways) {
    const { id: wayId, tags, nodeRefs } = way;

    // Build segments: collect nodes until we hit a split node
    let seg = [];
    for (let i = 0; i < nodeRefs.length; i++) {
      const nid = nodeRefs[i];
      const coord = nodeCoords.get(nid);
      if (!coord) continue; // node not in our extract (clipping artifact)

      seg.push({ nid, coord });

      const isSplitPoint = splitNodes.has(nid);
      const isLast = i === nodeRefs.length - 1;

      if ((isSplitPoint || isLast) && seg.length >= 2) {
        const fromNode = seg[0].nid;
        const toNode   = seg[seg.length - 1].nid;
        const coords   = seg.map(s => s.coord);

        const edge = {
          id: `${wayId}:${fromNode}:${toNode}`,
          way_id: wayId,
          from_node: fromNode,
          to_node: toNode,
          tags: filterTags(tags),
          geometry: {
            type: 'LineString',
            coordinates: coords,
          },
        };

        out.write(JSON.stringify(edge) + '\n');
        edgeCount++;

        // Start next segment from current split node
        if (isSplitPoint && !isLast) {
          seg = [{ nid, coord }];
        } else {
          seg = [];
        }
      } else if (isSplitPoint && seg.length === 1) {
        // Edge starts at a split node — keep it as segment start
      }
    }
  }

  out.end();
  await new Promise((resolve, reject) => { out.on('finish', resolve); out.on('error', reject); });

  console.log(`\nWrote ${edgeCount.toLocaleString()} edges to ${OUT}`);
  console.log('Run: npm run network:conflate');
}

function filterTags(tags) {
  const out = {};
  for (const [k, v] of Object.entries(tags)) {
    if (KEEP_TAGS.has(k) || k === 'highway' || k === 'service') out[k] = v;
  }
  return out;
}

main().catch(err => { console.error(err); process.exit(1); });

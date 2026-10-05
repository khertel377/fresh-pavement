// ArcGIS REST API fetch helpers.
// All sources are ArcGIS FeatureServer or MapServer layers.
// FeatureServer supports f=geojson; MapServer uses f=json and we convert.

const PAGE_SIZE = 2000;

/**
 * Returns the service's editingInfo.lastEditDate (ms epoch), or null if unavailable.
 * Used to skip re-fetching unchanged sources.
 */
export async function fetchEditDate(serviceUrl) {
  try {
    const res = await fetch(`${serviceUrl}?f=json`);
    const json = await res.json();
    return json.editingInfo?.lastEditDate ?? null;
  } catch {
    return null;
  }
}

/**
 * Fetches all features from an ArcGIS layer with pagination.
 * Returns an array of GeoJSON Feature objects (WGS84).
 *
 * @param {string} layerUrl - Full layer URL (ends with /FeatureServer/N or /MapServer/N)
 * @param {object} opts
 * @param {string} opts.fields - Comma-separated field list, default '*'
 * @param {string} opts.where - WHERE clause, default '1=1'
 */
export async function fetchAllFeatures(layerUrl, { fields = '*', where = '1=1' } = {}) {
  const isMapServer = /\/MapServer\//i.test(layerUrl);

  // Get total count first
  const countParams = new URLSearchParams({ where, returnCountOnly: 'true', f: 'json' });
  const countRes = await fetch(`${layerUrl}/query?${countParams}`);
  const countJson = await countRes.json();
  if (countJson.error) {
    throw new Error(`ArcGIS count error: ${JSON.stringify(countJson.error)}`);
  }
  const total = countJson.count;
  console.log(`  ${total.toLocaleString()} features`);

  const features = [];
  for (let offset = 0; offset < total; offset += PAGE_SIZE) {
    const fmt = isMapServer ? 'json' : 'geojson';
    const params = new URLSearchParams({
      where,
      outFields: fields,
      outSR: '4326',
      geometryPrecision: '6',
      orderByFields: 'OBJECTID',
      resultOffset: String(offset),
      resultRecordCount: String(PAGE_SIZE),
      f: fmt,
    });
    const res = await fetch(`${layerUrl}/query?${params}`);
    const json = await res.json();
    if (json.error) {
      throw new Error(`ArcGIS query error at offset ${offset}: ${JSON.stringify(json.error)}`);
    }

    const batch = fmt === 'geojson'
      ? (json.features || [])
      : (json.features || []).map(f => esriToGeoJSON(f, json.geometryType));

    features.push(...batch);
    process.stdout.write(`\r  ${features.length.toLocaleString()} / ${total.toLocaleString()}   `);
  }
  process.stdout.write('\n');
  return features;
}

// --- Esri JSON → GeoJSON conversion (used for MapServer responses) -----------

function esriToGeoJSON(feat, geometryType) {
  return {
    type: 'Feature',
    geometry: esriGeomToGeoJSON(feat.geometry, geometryType),
    properties: feat.attributes,
  };
}

function esriGeomToGeoJSON(geom, type) {
  if (!geom) return null;

  if (type === 'esriGeometryPolyline') {
    const paths = geom.paths || [];
    if (paths.length === 0) return null;
    return paths.length === 1
      ? { type: 'LineString', coordinates: truncCoordList(paths[0]) }
      : { type: 'MultiLineString', coordinates: paths.map(truncCoordList) };
  }

  if (type === 'esriGeometryPolygon') {
    const rings = geom.rings || [];
    if (rings.length === 0) return null;
    return rings.length === 1
      ? { type: 'Polygon', coordinates: [truncCoordList(rings[0])] }
      : { type: 'MultiPolygon', coordinates: rings.map(r => [truncCoordList(r)]) };
  }

  return null;
}

function truncCoordList(coords) {
  return coords.map(([x, y]) => [r6(x), r6(y)]);
}

function r6(v) {
  return Math.round(v * 1e6) / 1e6;
}

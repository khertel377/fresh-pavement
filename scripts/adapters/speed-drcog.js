// DRCOG regional speed limits adapter.
// Source: Regional_Speed_Limit/FeatureServer/0
// OID field is FID (not OBJECTID) — handled in fetch.js via oid_field config.

export function normalize(feature) {
  const p = feature.properties;

  // speed_limi is the posted speed in mph
  const speedMph = p.speed_limi != null ? +p.speed_limi : null;

  return {
    id: `speed-drcog:${p.FID ?? p.OBJECTID}`,
    source: 'speed-drcog',
    speed_mph: speedMph && speedMph > 0 ? speedMph : null,
    street_name: p.street_nam || null,
    data_source: p.data_sourc || null,
    geometry: feature.geometry,
  };
}

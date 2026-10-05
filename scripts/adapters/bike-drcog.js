// DRCOG regional bicycle facilities adapter.
// Source: Bicycle_Facilities/FeatureServer/0 — metro-wide inventory.

const FACILITY_MAP = {
  'SHARED USE PATH':       'shared_use_path',
  'LOCAL PATH':            'shared_use_path',
  'BICYCLE LANE':          'painted_lane',
  'SEPARATED BICYCLE LANE':'protected_lane',
  'SIDEPATH':              'sidepath',
  'BICYCLE BOULEVARD':     'neighborhood_bikeway',
  'UNPAVED PATH':          'unpaved_path',
  'PAVED SHOULDER':        'paved_shoulder',
};

export function normalize(feature) {
  const p = feature.properties;
  const raw = (p.fac_type || '').trim().toUpperCase();
  const facility = FACILITY_MAP[raw] ?? 'shared_lane';

  const surfaceRaw = (p.surface || '').toLowerCase();
  const surface = surfaceRaw.includes('pav') || surfaceRaw.includes('asph') || surfaceRaw.includes('conc')
    ? 'paved'
    : surfaceRaw.includes('unpav') || surfaceRaw.includes('dirt') || surfaceRaw.includes('gravel')
      ? 'unpaved'
      : null;

  return {
    id: `bike-drcog:${p.OBJECTID}`,
    source: 'bike-drcog',
    facility,
    facility_raw: raw,
    install_year: null,
    name: p.street || null,
    surface,
    width_ft: p.width ?? null,
    horiz_buf_ft: p.horiz_buf ?? null,
    geometry: feature.geometry,
  };
}

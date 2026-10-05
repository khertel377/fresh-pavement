// Denver ODC bicycle facilities adapter.
// Source: Denver_Bicycle_Facilities_ODC/FeatureServer/450
// Filter: DISPLAY_STATUS LIKE 'Existing Bikeway%' (applied server-side in fetch.js)

const FACILITY_MAP = {
  'Protected Bike Lane':  'protected_lane',
  'Buffered Bike Lane':   'buffered_lane',
  'Bike Lane':            'painted_lane',
  'Neighborhood Bikeway': 'neighborhood_bikeway',
  'Shared Street':        'neighborhood_bikeway',
  'Car-Free Street':      'protected_lane',
  'Trail':                'shared_use_path',
  'Shared Sidewalk':      'sidepath',
  'Shared Lane':          'shared_lane',
  'Paved Shoulder':       'paved_shoulder',
};

export function normalize(feature) {
  const p = feature.properties;
  const raw = (p.FACILITY_TYPE_EXISTING || '').trim();
  const facility = FACILITY_MAP[raw] ?? 'shared_lane';

  return {
    id: `bike-denver:${p.OBJECTID}`,
    source: 'bike-denver',
    facility,
    facility_raw: raw,
    install_year: p.INSTALL_YEAR || null,
    name: p.FACILITY_NAME || null,
    surface: null,
    geometry: feature.geometry,
  };
}

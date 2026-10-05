// Denver DOTI pavement treatment adapter.
// Source: FeatureServer/428 — treatment + condition data.
//
// Logic validated against Franklin St (Colfax–26th): HIPR 2026 → skate score 85.
// See index.html interpret() for the original reference implementation.

const NOW = new Date().getFullYear();

// Map raw treatment strings → normalized vocabulary
export function mapTreatment(raw) {
  if (!raw) return null;
  const s = raw.toLowerCase().trim();
  if (/chip\s*seal|cape\s*seal/.test(s)) return 'chip_seal';
  if (/hipr|hot.in.place|hot-in-place/.test(s)) return 'hipr';
  // reconstruct / full depth before the broader mill/overlay catch
  if (/reconstruct|full\s*depth/.test(s)) return 'reconstruct';
  if (/mill|overlay|go\s*bond|central\s*70|external\s*paving/.test(s)) return 'mill_overlay';
  if (/concrete/.test(s)) return 'concrete';
  if (/slurry/.test(s)) return 'slurry_seal';
  if (/crack\s*seal/.test(s)) return 'crack_seal';
  if (/reclamite/.test(s)) return 'reclamite';
  return 'other';
}

// EstimatedOCR text → numeric score (rough proxy; treatment data wins)
// confidence=low because this field is not refreshed after paving.
function ocrToScore(ocr) {
  const map = { excellent: 90, good: 70, fair: 50, poor: 30, 'very poor': 25, failed: 10 };
  return map[(ocr || '').toLowerCase().trim()] ?? null;
}

/**
 * Normalize one GeoJSON feature from the Denver layer.
 * Returns a normalized record, or null to skip (CDOT/Private jurisdiction).
 */
export function normalize(feature) {
  const p = feature.properties;

  // Skip non-city-maintained segments
  const jur = (p.Jurisdiction || '').toUpperCase().trim();
  if (jur === 'CDOT' || jur === 'PRIVATE') return null;

  const cy = p.Committed_Year || null;
  const yl = p.YR_LSTWK > 1900 ? p.YR_LSTWK : null;
  const done = !!(cy && yl && yl === cy);
  const planned = !!(cy && cy >= NOW && !done);

  // Determine the surface currently on the road
  let ltType = null;
  let ltYear = yl;

  if (done) {
    ltType = mapTreatment(p.CCD_Treatment);
  } else {
    // Parse TreatmentComment: "2017 MILL AND OVERLAY", "previous treatment was 2005 HIPR", etc.
    const m = (p.TreatmentComment || '').match(/((?:19|20)\d{2})\s*([A-Za-z].*)/);
    if (m) {
      const commentYear = +m[1];
      if (!yl || commentYear === yl) {
        ltType = mapTreatment(m[2]);
        if (!ltYear) ltYear = commentYear;
      }
    }
  }

  return {
    id: `denver:${p.MASTER_ID || p.OBJECTID}`,
    source: 'denver',
    name: p.GIS_FULLNAME || '',
    from: p.FROMNAME || '',
    to: p.TONAME || '',
    last_treatment: ltType ? { type: ltType, year: ltYear, date: null } : null,
    planned: planned ? { type: mapTreatment(p.CCD_Treatment), year: cy } : null,
    condition: p.EstimatedOCR ? {
      index: 'OCR',
      raw: p.EstimatedOCR,
      score: ocrToScore(p.EstimatedOCR),
      date: null,
      iri: null,
    } : null,
    skate_score: null, // computed by build.js
    geometry: feature.geometry,
    extra: {
      lane_miles: p.Lane_Miles || null,
      moratorium_year: p.MORATORIUM_THRU_YEAR || null,
      crew: p.SMDCrew || null,
      treatment_comment: p.TreatmentComment || null,
    },
  };
}

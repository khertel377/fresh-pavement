// Lakewood Cartegraph pavement adapter.
// Source: cgPavement/MapServer/3 (native SR 2877 → requested as outSR=4326)
// Has both condition (OCI) and treatment history year fields.
//
// The lgSs_*_YEAR fields come back as Esri Date values (ms since epoch).

function esriDateYear(val) {
  if (!val || val <= 0) return null;
  return new Date(val).getFullYear();
}

/**
 * Normalize one GeoJSON feature from the Lakewood pavement layer.
 */
export function normalize(feature) {
  const p = feature.properties;

  const overlayYear   = esriDateYear(p.lgSs_LAST_OVERLAY_YEAR);
  const cracksealYear = esriDateYear(p.lgSs_LAST_CRACKSEAL_YEAR);
  const reclamiteYear = esriDateYear(p.lgSs_LAST_RECLAMITE_YEAR);
  const concreteYear  = esriDateYear(p.lgSs_LAST_CONCRETE_YEAR);
  const nextOverlay   = esriDateYear(p.lgSs_NEXT_OVERLAY_YEAR);

  // Last treatment = most recent of overlay, crack seal, reclamite, concrete
  const candidates = [
    overlayYear   ? { type: 'mill_overlay', year: overlayYear }   : null,
    cracksealYear ? { type: 'crack_seal',   year: cracksealYear } : null,
    reclamiteYear ? { type: 'reclamite',    year: reclamiteYear } : null,
    concreteYear  ? { type: 'concrete',     year: concreteYear }  : null,
  ].filter(Boolean);
  candidates.sort((a, b) => b.year - a.year);
  const lastTreatment = candidates[0] ?? null;

  // Prefer inspection OCI over estimated OCI
  const oci = p.cg_CurrentInspectionOCI ?? p.cg_EstimatedOCI ?? null;
  const ociDate = p.cg_CurrentInspectionDate
    ? new Date(p.cg_CurrentInspectionDate).toISOString().slice(0, 10)
    : null;

  return {
    id: `lakewood:${p.OBJECTID}`,
    source: 'lakewood',
    name: p.cg_Street || '',
    from: p.cg_FromStreet || '',
    to: p.cg_ToStreet || '',
    last_treatment: lastTreatment,
    planned: nextOverlay ? { type: 'mill_overlay', year: nextOverlay } : null,
    condition: oci != null ? {
      index: 'OCI',
      raw: oci,
      score: oci, // OCI is 0–100
      date: ociDate,
      iri: null,
    } : null,
    skate_score: null, // computed by build.js
    geometry: feature.geometry,
    extra: {
      estimated_oci: p.cg_EstimatedOCI ?? null,
    },
  };
}

// Aurora pavement condition adapter.
// Source: Pavement_Condition_Index_2025_View_Only/FeatureServer/0
// Condition only (PCI + IRI). No treatment history in this layer.
//
// TODO: merge aurora_rehab layer (Streets_Rehabilitation_2025_View_Only/FeatureServer/0)
// once its fields are confirmed. Inspect with:
//   curl "https://services3.arcgis.com/0Va1ID99NSrNyyPX/arcgis/rest/services/Streets_Rehabilitation_2025_View_Only/FeatureServer/0?f=json"

/**
 * Normalize one GeoJSON feature from the Aurora PCI layer.
 */
export function normalize(feature) {
  const p = feature.properties;

  const pci = p.PCI ?? null;
  // IRI = -1 means missing in Aurora's data — treat as null (otherwise it scores 100)
  const iri = (p.IRI != null && p.IRI > 0) ? p.IRI : null;

  return {
    id: `aurora:${p.OBJECTID}`,
    source: 'aurora',
    name: p.STREET_NAM || '',
    from: null,
    to: null,
    last_treatment: null, // not available in PCI layer
    planned: null,
    condition: (pci != null || iri != null) ? {
      index: 'PCI',
      raw: pci,
      score: pci,   // PCI is already 0–100
      date: null,
      iri: iri,
    } : null,
    skate_score: null, // computed by build.js
    geometry: feature.geometry,
    extra: {
      pci_category: p.PCI_Category || null,
      iri_category: p.IRI_Category || null,
      normalized_iri: p.Normalized_IRI ?? null,
    },
  };
}

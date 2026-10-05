// Skate score computation using the 7-band rider ladder.
// All constants and source mappings live in config/score.json — edit there to retune.
//
// Band order (best → worst): fresh → excellent → good → fair → poor → very_poor → failed
// Each band has a fixed anchor score so colors are consistent across cities.

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(readFileSync(join(__dirname, '../../config/score.json'), 'utf8'));

const BAND_ORDER = cfg.band_order;
const MAINTENANCE_ONLY = new Set(['crack_seal', 'reclamite']);

function bandIdx(name) {
  return BAND_ORDER.indexOf(name); // -1 if unknown
}

// Band with the higher index (worse quality) of two
function worseBand(a, b) {
  if (!a) return b;
  if (!b) return a;
  return bandIdx(a) >= bandIdx(b) ? a : b;
}

// Treatment type + age → band name, or null if unknown type
function bandFromTreatment(ltType, age) {
  const tx = cfg.treatment_bands[ltType];
  if (!tx) return null;

  const startI = bandIdx(tx.start);
  if (startI === -1) return null;

  const steps = Math.floor(age / tx.step_years);
  let idx = startI + steps;

  // cap: band can never be *better* than cap (i.e. index must be >= cap index)
  if (tx.cap) idx = Math.max(idx, bandIdx(tx.cap));

  // floor at the worst band
  idx = Math.min(idx, BAND_ORDER.length - 1);
  return BAND_ORDER[idx];
}

// PCI or OCI value (0–100) → band name
function bandFromPCI(score) {
  if (score == null) return null;
  for (const entry of cfg.pci_bands) {
    if (score >= entry.min) return entry.band;
  }
  return 'failed';
}

// Aurora IRI_Category string → band name
// Aurora measures at city-street speeds; don't apply FHWA highway thresholds.
function bandFromIRICategory(category) {
  if (!category) return null;
  const key = category.toLowerCase().trim();
  if (key === '#n/a' || key === 'n/a' || key === '') return null;
  return cfg.aurora_iri_bands[key] ?? null;
}

// Denver EstimatedOCR text → band name
function bandFromOCR(ocr) {
  if (!ocr) return null;
  const key = ocr.toLowerCase().trim();
  return cfg.denver_ocr_bands[key] ?? null;
}

// Blend PCI and IRI bands: weight IRI 2/3, PCI 1/3 (roughness is ride quality)
function blendPCIIRI(pciBand, iriBand) {
  if (!pciBand && !iriBand) return null;
  if (!pciBand) return iriBand;
  if (!iriBand) return pciBand;
  const blended = bandIdx(pciBand) * (1 / 3) + bandIdx(iriBand) * (2 / 3);
  return BAND_ORDER[Math.round(blended)];
}

/**
 * Compute the skate band and score for a normalized record.
 *
 * Returns { band, skate_score, basis, confidence } or null if unscored.
 *
 * basis: 'treatment' | 'treatment+condition' | 'pci' | 'oci' | 'iri' | 'pci+iri' | 'rating'
 * confidence: 'high' | 'medium' | 'low'
 */
export function computeBand(record) {
  const NOW = new Date().getFullYear();
  const lt = record.last_treatment;
  const ci = record.condition;
  const ex = record.extra || {};

  // --- Treatment band ---
  let treatmentBand = null;
  let treatmentAge = null;
  if (lt && lt.year && lt.type && !MAINTENANCE_ONLY.has(lt.type)) {
    treatmentAge = NOW - lt.year;
    treatmentBand = bandFromTreatment(lt.type, treatmentAge);
  }

  // --- Condition band ---
  let conditionBand = null;
  let conditionBasis = null;
  if (ci) {
    if (record.source === 'aurora') {
      // Aurora: use IRI_Category (city-scale) + PCI, blend 2:1 toward IRI
      const iriBand = bandFromIRICategory(ex.iri_category);
      const pciBand = bandFromPCI(ci.score);
      conditionBand = blendPCIIRI(pciBand, iriBand);
      if (conditionBand) {
        conditionBasis = iriBand && pciBand ? 'pci+iri' : iriBand ? 'iri' : 'pci';
      }
    } else if (ci.index === 'OCR') {
      // Denver EstimatedOCR text rating (low confidence — not refreshed after paving)
      conditionBand = bandFromOCR(ci.raw);
      conditionBasis = conditionBand ? 'rating' : null;
    } else {
      // PCI (Aurora city layer) or OCI (Lakewood)
      conditionBand = bandFromPCI(ci.score);
      conditionBasis = conditionBand ? (ci.index === 'OCI' ? 'oci' : 'pci') : null;
    }
  }

  // --- Merge treatment and condition ---
  let band, basis, confidence;

  if (treatmentBand) {
    const treatmentIsRecent = treatmentAge <= cfg.treatment_wins_within_years;
    if (!conditionBand || treatmentIsRecent) {
      // Recent treatment wins, or we have nothing else
      band = treatmentBand;
      basis = 'treatment';
      confidence = treatmentIsRecent ? 'high' : 'medium';
    } else {
      // Old treatment + condition: use whichever is worse (condition reflects actual aging)
      band = worseBand(treatmentBand, conditionBand);
      basis = 'treatment+condition';
      confidence = conditionBasis === 'rating' ? 'low' : 'medium';
    }
  } else if (conditionBand) {
    band = conditionBand;
    basis = conditionBasis;
    confidence = conditionBasis === 'rating' ? 'low' : 'medium';
  } else {
    return null; // unscored
  }

  const skate_score = cfg.bands[band]?.score ?? null;
  return { band, skate_score, basis, confidence };
}

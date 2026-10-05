# Fresh Pavement: brief 2, make scores comparable across cities

## Problem
In the metro preview, Aurora renders almost entirely orange/yellow, and colors jump at city borders. Aurora's streets aren't really worse. The scoring treats each source differently. I checked the normalized data (`data/normalized/*.ndjson`) and found the causes below.

### 1. Aurora IRI is on an urban scale, but we use highway thresholds (main bug)
`iriToScore()` in `scripts/lib/score.js` uses FHWA highway breakpoints (95 / 170 in/mi). Aurora measures at city-street speeds, so its numbers run much higher:

| Aurora `IRI_Category` | IRI range (in/mi) | median |
|---|---|---|
| Good | 70–141 | 126 |
| Satisfactory | 142–238 | 196 |
| Fair | 239–336 | 280 |
| Poor | 337–433 | 373 |
| Very Poor | 434–531 | 469 |
| Serious | 532–628 | 572 |
| Failed | 631–700 | 700 |
| #N/A | **-1** | |

So the median Aurora street (IRI ≈ 247, "Fair" by Aurora's own scale) scores ~33 on roughness, and averaging that with PCI ~78 pulls everything to the orange range.
**Second bug:** `IRI = -1` (missing) currently scores **100**. Treat ≤0 as null.

### 2. Denver's condition fallback misses a category
In `scripts/adapters/denver.js`, `ocrToScore()` has no `"very poor"` entry, so 463 segments go unscored. Blank strings (674) should be null, as they already are.

### 3. No shared scale
Treatment-age scores, PCI, OCI, IRI and text ratings all get turned into 0–100 numbers in different ways. The map colors those numbers as if they meant the same thing.

## Fix: one shared ladder
Every source maps to the same **7 rider-facing bands** first, and each band has one score anchor. Colors come from the band, so a "Good" street looks the same in every city.

| Band | Anchor score | Meaning for a rider |
|---|---|---|
| fresh | 97 | new mill & overlay / reconstruct, ≤2 seasons |
| excellent | 88 | glassy |
| good | 76 | smooth, minor cracks |
| fair | 62 | rideable, some cracks/patches |
| poor | 45 | rough, pick your line |
| very_poor | 28 | avoid |
| failed | 10 | no |

Put the band definitions and every source's mapping in `config/score.json`, so tuning never needs a code change.

### Source → band mappings (v1)
- **Treatment-based** (any source with `last_treatment`). Base band by type, then step down one band per N years:
  - mill_overlay / reconstruct: `fresh` for years 0–2, then down a band every 3 yrs.
  - hipr: starts at `excellent`, down a band every 3 yrs.
  - slurry_seal: starts at `fair`. chip_seal: starts at `poor`, always ≤ `poor` (rough aggregate).
  - concrete: `fair` (joints).
  - crack_seal / reclamite: don't set the band; fall through to condition.
- **PCI / OCI** (0–100, ASTM D6433 bands): 86–100 excellent · 71–85 good · 56–70 fair · 41–55 poor · 26–40 very_poor · ≤25 failed (11–25 "Serious" folds into very_poor/failed; pick one and note it).
- **Aurora IRI**: use Aurora's own `IRI_Category`, already in `extra`: Good→excellent, Satisfactory→good, Fair→fair, Poor→poor, Very Poor→very_poor, Serious/Failed→failed, #N/A→null. Don't apply highway IRI thresholds to city streets. Keep a highway-scale mapping only for CDOT later.
- **Combining PCI + IRI for the same segment:** IRI measures roughness, which is literally ride quality, so weight it more. Take the band that's 1/3 PCI, 2/3 IRI (average band indexes, round toward IRI).
- **Denver EstimatedOCR**: Excellent→excellent, Good→good, Fair→fair, Poor→poor, Very Poor→very_poor, Failed→failed. Mark these `confidence: low`, since the field isn't refreshed after paving.
- **Treatment vs condition conflict:** if the treatment is within 3 years, the treatment wins. Otherwise use the worse of the two bands. Condition data that's newer than the treatment means the street has aged.

Output per segment: `band`, `skate_score` (= band anchor, ± small nudge within band is optional), `basis` (`treatment | pci | oci | iri | pci+iri | rating`) and `confidence` (`high | medium | low`). Show `basis` and `confidence` in the popup ("Score from: Aurora 2025 roughness survey").

## Verification (add as `npm run check-scores`)
1. **Distribution report per source:** the share of segments in each band. Print it on every build. Expect roughly similar shapes for Denver, Aurora and Lakewood. Flag any source with >60% in one band.
2. **Border seam check:** for segments within ~500 m of a city boundary, compare band distributions on each side. A large difference means calibration is off, not that the streets are.
3. **Rider calibration file:** `config/calibration.json` holds Kevin's own ratings of known streets, e.g.
   `{"street": "N Franklin St", "from": "E Colfax Ave", "to": "E 26th Ave", "rider_band": "excellent", "source": "denver"}`.
   The script reports predicted vs rider band per entry and overall agreement. Seed it with Franklin (Colfax–26th, HIPR 2026) and leave a TODO for Kevin to add ~5 streets per city.
4. Unit tests for the edge cases: IRI −1, missing categories, chip seal never above poor, and fresh mill & overlay = fresh.

## Map changes
- Color by `band` using a 7-step ramp: the current palette, plus a distinct "fresh" color. Unscored streets stay visibly distinct.
- Legend shows band names, not numbers.
- Popup: band, basis, confidence, data date, source name.

## Done when
- Aurora's band distribution looks plausible next to Denver and Lakewood (report printed in the PR/commit message).
- No visible color seam at the Denver–Aurora and Denver–Lakewood borders at metro zoom.
- Franklin St (Colfax–26th) is `excellent`. Denver 2025 mill & overlay blocks are `fresh`.
- All constants live in `config/score.json`. README "How the score works" is updated in plain language.

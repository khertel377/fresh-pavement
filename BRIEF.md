# Fresh Pavement: Phase 1 brief for Claude Code

## What this is
A map of Denver-metro street surface quality for skateboarders and EUC riders: where it's freshly paved, where it's smooth, what's coming. Kevin is the owner and is a designer, not an engineer. Explain choices plainly, keep the stack boring, and ask before anything that costs money or creates accounts.

Background lives in this folder:
- `index.html`: working prototype. Single-page MapLibre map that fetches Denver's layer live in the browser. Keep its look and interactions; it's the design reference.
- `sources.json`: registry of 21 audited public data sources (URLs, key fields, tier, cadence).
- Full research notes: claude.ai project "Fresh Pavement" → `claude/research-and-plan.md` and `claude/metro-data-audit.md`.

## Phase 1 goal
Replace "browser hits city servers on every load" with a **pipeline**: fetch → normalize → publish one combined dataset. Then deploy the map to **Vercel** so it works on a phone. Start with **Denver, Aurora and Lakewood**.

Done when:
1. `npm run fetch` (or a Python equivalent) pulls the 3 sources and writes normalized data.
2. `npm run build` produces the map data file(s) the site loads.
3. A GitHub Actions workflow runs that on a schedule and on manual dispatch, then commits updated data. Vercel redeploys on push.
4. The site on Vercel shows all three cities with one consistent skate score, and the prototype's modes still work.

## Constraints and gotchas
- All sources are ArcGIS REST services. Page with `resultOffset`/`resultRecordCount` (max 1000–2000 per request), always request `outSR=4326`, and use `f=geojson` where supported. On MapServer layers `f=geojson` may not be supported, so use `f=json` and convert.
- The network matters: Claude's cloud sandbox and the shell in Kevin's Cowork VM are both blocked from arcgis.com. Kevin's own Mac and GitHub Actions are not. Run fetches locally or in Actions.
- Data is big: Denver alone is ~13.6 MB of GeoJSON for 29.7k segments. Simplify geometry (6-decimal coordinates are plenty; Douglas-Peucker ~1 m), keep only the fields the app needs, and gzip. Stretch goal: PMTiles via `tippecanoe` in Actions. Only do it if the file size hurts on a phone.
- Cadence: monthly Apr–Nov, plus Jan and Mar (new plans). Before downloading, compare each layer's `editingInfo.lastEditDate`, where available, against the last run and skip unchanged sources.
- History: commit normalized per-source files (sorted NDJSON, stable ids) under `data/normalized/`. Then git diff *is* the change log, e.g. "segment X flipped to done this month". No database in phase 1.

## Normalized schema (one record per source segment)
```json
{
  "id": "denver:12345",            // source id + stable source key (Denver MASTER_ID / OBJECTID fallback)
  "source": "denver",
  "name": "N FRANKLIN ST", "from": "E COLFAX AVE", "to": "E 16TH AVE",
  "last_treatment": { "type": "hipr", "year": 2026, "date": null },   // null if unknown
  "planned": { "type": "mill_overlay", "year": 2029 },                // null if none
  "condition": { "index": "PCI", "raw": 72, "score": 72, "date": "2025-06-01", "iri": 110 },  // null if none
  "skate_score": 85,               // computed, 0–100 or null
  "geometry": { ...LineString/MultiLineString, WGS84 }
}
```
Treatment vocabulary: `mill_overlay | reconstruct | hipr | chip_seal | slurry_seal | crack_seal | reclamite | concrete | other`.

## Source adapters (phase 1)
**Denver**: `https://services1.arcgis.com/zdB7qR0BtYrg0Xpl/arcgis/rest/services/Denver_Pavement_Treatments/FeatureServer/428`
- Done = `YR_LSTWK == Committed_Year`, and that sets last_treatment from `CCD_Treatment`. Planned = `Committed_Year >= current year` and not done.
- Otherwise, parse the previous treatment from `TreatmentComment` (e.g. "2017 MILL AND OVERLAY", "previous treatment was 2005Mill and Overlay") when its year matches `YR_LSTWK`.
- Map treatments: Mill and Overlay, Contract Mill and Overlay, Reconstruct, Full Depth Paving, GO Bond → mill_overlay/reconstruct; HIPR → hipr; Chip Seal → chip_seal; Concrete Repair/Panels → concrete.
- `EstimatedOCR` (Excellent…Failed) goes into condition as a rating. It is NOT refreshed after paving, so treatment wins.
- Skip or flag `Jurisdiction` = CDOT / Private (no city data).
- See `interpret()` in `index.html` for the current logic, which is verified against Franklin St (Colfax–26th = HIPR 2026).

**Aurora**: `https://services3.arcgis.com/0Va1ID99NSrNyyPX/arcgis/rest/services/Pavement_Condition_Index_2025_View_Only/FeatureServer/0` (15.3k segs)
- Fields: `STREET_NAM`, `PCI`, `PCI_Category`, `IRI`, `Normalized_IRI`, `IRI_Category`. Condition only.
- Optional treatment layer: `.../Streets_Rehabilitation_2025_View_Only/FeatureServer/0`, i.e. 2025 overlays. Inspect its fields first.

**Lakewood**: `https://egis.lakewood.org/server/rest/services/PW/cgPavement/MapServer/3` (5.0k segs, native SR 2877)
- Fields: `cg_Street`, `cg_FromStreet`, `cg_ToStreet`, `cg_EstimatedOCI`, `cg_CurrentInspectionOCI`, `cg_CurrentInspectionDate`, `lgSs_LAST_OVERLAY_YEAR`, `lgSs_NEXT_OVERLAY_YEAR`, `lgSs_LAST_CRACKSEAL_YEAR`, `lgSs_LAST_RECLAMITE_YEAR`, `lgSs_LAST_CONCRETE_YEAR`.
- The *_YEAR fields are esri Date types, so take the year from them.
- last_treatment = the most recent of overlay (mill_overlay), crack seal, reclamite, concrete. planned = next overlay.

## Skate score v1
- **Treatment, if done within ~10 yrs**: base mill_overlay/reconstruct 100, hipr 85, slurry_seal 45, concrete 55, chip_seal 20, crack_seal/reclamite → don't override (they're maintenance, not resurfacing). Subtract a per-year decay (mill_overlay 7, hipr 8, slurry 5, concrete 3, chip 2). Floor 5.
- **Else condition**: PCI/OCI → score = value (0–100). If IRI (in/mi) is present, blend toward an IRI score: ≤60 → 100, 95 → 80, 170 → 40, ≥250 → 10 (linear between).
- **Else null** ("unscored").
- Keep the constants in one config file. They'll be tuned once riders give feedback.

## Site
- Port `index.html` into a minimal Vercel static site (plain HTML/JS or Vite, whichever is simpler). It loads `/data/segments.geojson(.gz)` instead of ArcGIS.
- Keep the modes: Skate score, Paved this year, Last 3 seasons, Planned. Keep "hide chip seal".
- Fix: make unscored streets visibly distinct from the basemap (thin dashed or lower-contrast neutral).
- Add: a source/city label and "data as of <run date>" in the popup and panel.
- Kevin has deployed to Vercel before. Use the Vercel CLI, or connect the GitHub repo in the dashboard. Ask Kevin before creating the repo or project.

## Out of scope for phase 1 (next phases)
Rider ratings and "just paved" reports (Supabase), the other ~18 sources in `sources.json`, OpenStreetMap conflation (aligning every city's segments onto shared OSM streets), routing, and contributing OSM `smoothness=*`.

## Suggested order
1. `git init`, repo skeleton, `sources.json` → `config/`.
2. Denver adapter + normalize + build. Check it matches the prototype (Franklin = 85).
3. Aurora and Lakewood adapters. Spot-check a few segments against each city's own map.
4. Site port, then local preview.
5. GitHub repo + Actions workflow + Vercel deploy (confirm with Kevin first).
6. Write a short README covering how to run, how to add a source, and how the score works.

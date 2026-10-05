# Fresh Pavement: brief 5, the combined "Ride" map

Design reference: `design/ride-map-system.html`. Read its grammar, legend matrix and implementation notes first. This becomes the **default view**. Smoothness / Traffic stress / Bike facilities stay as detail tabs.

## Grammar (one channel per question)
| Question | Channel | Values |
|---|---|---|
| Do I have my own space? | **weight + casing** | trail/protected = thick with dark casing · painted/buffered lane = medium · neighborhood bikeway, calm street = thin |
| How stressful is traffic? | **hue** | green = bike facility · warm white `#d9d4c7` = calm (LTS 1–2, no facility) · amber `#e8a33d` = LTS 3 · red `#e5534b` = LTS 4. Facility greens: `#3fd68f` (trail/protected/lane), `#9fe6bf` (bikeway) |
| How does the surface feel? | **texture** | fresh = solid + blurred glow + thin highlight · excellent/good = solid · fair = fine grain · poor/very_poor/failed = coarse gravel · no data = faint hairline |
| How sure are we? | **opacity** | confidence high = 1 · medium = 0.75 · low = 0.5. Never dashes. |

No dashes anywhere in this view. Texture is the only "broken" signal.

## Pipeline prerequisites
1. **Per-edge `ride_class`**: `path | lane | bikeway | calm | busy | hostile`. Facility type wins (green); otherwise LTS 1–2 → calm, 3 → busy, 4 → hostile.
2. **Per-edge `surface`**: `fresh | smooth | fair | rough | none`, from band (fresh; excellent+good; fair; poor+very_poor+failed; null).
3. **Per-edge `confidence`**: the lower of the surface confidence and the LTS confidence.
   - LTS is **low** if speed or lanes came from class defaults. It's **medium** if from DRCOG/OSM but the facility is OSM-only. It's **high** if speed is from OSM/DRCOG and the facility is from city data.
   - Surface confidence comes from the scoring brief (treatment within 3 yrs or IRI = high; PCI/OCI = medium; Denver EstimatedOCR = low).
4. **Check the LTS fallback rate.** The current Traffic stress view is almost all LTS 1, which suggests most residential edges are using the 25 mph default. Report the share of edges whose speed came from OSM / DRCOG / default, by city. If the DRCOG speed conflation isn't matching, fix that first. Then make the default case show `confidence: low` rather than confidently green.

## Rendering (MapLibre, PMTiles)
- **Layers, bottom → top:** calm+none → busy → hostile → bikeway → lane → path-casing → path. Green is always on top, so a protected lane along a red arterial reads as the lane.
- **Textures:** generate `line-pattern` sprites at runtime with canvas + `map.addImage` (classes × {fair, rough}; smooth is a plain line). "Fresh" = extra layer with `line-blur` and a wide, low-opacity line, plus a thin light highlight line.
- **Zoom:** patterns from z14 up. Below z14, roughness → opacity (smooth 1, fair .75, rough .45) and widths shrink. At z ≤ 12, calm streets fade to ~.5 so the facility network and red arterials carry the picture.
- **Popup:** one line per question, with the reason ("Painted lane · LTS 3 (35 mph, 4 lanes) · Surface fair (Denver 2025 survey) · Confidence: medium (speed from DRCOG)"). Each term links into the Field Guide.
- **Legend:** a compact version of the matrix: 4 hue swatches, 3 weights, 4 textures, and an "estimated" opacity sample.
- **Color-blind check:** run the legend and a metro screenshot through a CVD simulator. Facilities must still read through weight/casing.
- Retire the "Good to ride" checkbox. In the combined view it becomes a **"Hide high-stress"** toggle (dims busy/hostile to 15%) plus an optional **"Hide rough"** toggle.

## Done when
- The Ride view is the default and matches the reference page at z15 and at metro zoom.
- The LTS provenance report is printed. Fallback-default edges render at low confidence.
- Spot checks: Franklin (Colfax–26th) = calm, solid. Colfax = red. Broadway protected lane = thick green tube. Cherry Creek Trail = thick green tube.

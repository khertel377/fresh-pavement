# Fresh Pavement: brief 3, OSM base network, traffic stress and bike facilities

Start this after BRIEF-scoring is merged; it builds on the bands. Goal: move from "each city's own segments drawn on a map" to **one combined street network built on OpenStreetMap**. Every street edge carries smoothness (from city data), level of traffic stress (LTS 1–4) and bike facility type. Add **bike facilities** and **traffic stress** as map layers.

## Why OSM as the base
- One consistent, routable network across all cities. Stable ids let rider ratings, history and city data all attach to the same edge.
- It has tags we need for traffic stress (highway class, lanes, maxspeed, cycleway, parking).
- Later we can contribute `smoothness=*` back.
- **License:** OSM is ODbL. Show "© OpenStreetMap contributors" on the map. The combined dataset we publish is a derivative database, so publish it under ODbL too. That's fine for this open project; just note it in the README.

## Data inputs (all verified public, Oct 2026)
| Input | Use | Endpoint |
|---|---|---|
| OSM | base network + tags | Geofabrik Colorado extract `https://download.geofabrik.de/north-america/us/colorado-latest.osm.pbf`. Clip to metro bbox with `osmium`. Prefer it over Overpass, which rate-limits fast. |
| Denver bike facilities | facility type, protected/buffered, install year, status | `https://services1.arcgis.com/zdB7qR0BtYrg0Xpl/arcgis/rest/services/Denver_Bicycle_Facilities_ODC/FeatureServer/450` (2,025 segs). Use `FACILITY_TYPE_EXISTING`: Protected Bike Lane, Buffered Bike Lane, Bike Lane, Neighborhood Bikeway, Shared Street, Car-Free Street, Trail, Shared Sidewalk. Keep only `DISPLAY_STATUS` starting "Existing Bikeway"; "Future Bikeway" can be a planned layer later. |
| DRCOG regional bike inventory | facilities across the whole metro | `https://services2.arcgis.com/lCUrzfRwZYxmwIse/arcgis/rest/services/Bicycle_Facilities/FeatureServer/0` (21,946 segs). `fac_type`: SHARED USE PATH, LOCAL PATH, BICYCLE LANE, SEPARATED BICYCLE LANE, SIDEPATH, BICYCLE BOULEVARD, UNPAVED PATH, PAVED SHOULDER. Has `status`, `surface`, `width`, `horiz_buf`, `vert_bar`. |
| DRCOG regional speed limits | fills OSM `maxspeed` gaps (OSM has it on only ~39% of Denver roads) | `https://services2.arcgis.com/lCUrzfRwZYxmwIse/arcgis/rest/services/Regional_Speed_Limit/FeatureServer/0` (91k segs; fields `speed_limi`, `street_nam`, `data_sourc`; OID field is `FID`) |
| CDOT traffic counts | AADT on state highways (optional LTS input) | `https://dtdapps.codot.gov/server/rest/services/Webapps/open_data_sde/FeatureServer/13` |
| DRCOG high injury network | optional "caution" overlay | `https://services2.arcgis.com/lCUrzfRwZYxmwIse/arcgis/rest/services/REGIONAL_HIGH_INJURY_NETWORK_AND_CRITICAL_CORRIDORS/FeatureServer/0` |
| Denver neighborhood bikeway traffic calming | points; nice-to-have for LTS on bikeways | `https://services1.arcgis.com/zdB7qR0BtYrg0Xpl/arcgis/rest/services/ODC_TRANS_TRAFFICCALMING_P2/FeatureServer/383` |

Add these to `config/sources.json` with a `role` field (`pavement | network | facility | speed | volume | safety`).

## Step 1: build the base network
- Monthly in Actions: download the Geofabrik extract (~250 MB, so cache it). Run `osmium extract` on a bbox covering Denver, Aurora and Lakewood (expand later), then `osmium tags-filter` for `highway=*`, dropping motorway/trunk/ramps, footways, steps and service=driveway/parking_aisle.
- Keep tags: name, highway, lanes, lanes:forward/backward, maxspeed, oneway, surface, smoothness, cycleway*, bicycle, parking*, sidewalk, lit, access.
- **Split ways into edges at intersections.** Edge id = `osmWayId:fromNodeId:toNodeId`. This is the stable key for everything else.
- Output `data/network/edges.ndjson` (geometry + tags).

## Step 2: conflate city data onto edges
For each source feature (pavement, bike facilities, speed limits):
1. Candidate edges = edges within ~15 m. Use a spatial index (`flatbush`/`rbush` + `@turf/turf` in Node, or geopandas if Python is easier; your call, but stay consistent).
2. Filter by **name similarity**. Normalize "N FRANKLIN ST" ≈ "North Franklin Street": strip directionals, expand suffixes, lowercase. Allow a missing name for paths.
3. Filter by **bearing difference** < 20°.
4. Score by **overlap**, i.e. the share of edge length inside the source buffer. Assign if ≥ 50%.
5. If several source features hit one edge, take the one with most overlap. For pavement, keep the best band *and* the list of contributing source ids.
6. Polygon sources (later: Arvada, Boulder, Castle Rock) are intersected with edges.

Write `data/network/match-report.json` for every source: match rate (by count and by length), unmatched features (with ids), and edges with conflicting matches. **Target ≥ 90% of pavement length matched** for Denver/Aurora/Lakewood before switching the map to edges. Until then, keep the current city-geometry map behind a flag.

## Step 3: level of traffic stress (LTS 1–4)
Use a simplified Furth/Mekuria segment model (Mineta Transportation Institute, 2012/2017). The BikeOttawa "stressmodel" project and PeopleForBikes' Bike Network Analysis are good references for OSM-tag rules. Check their licenses before copying code; implementing the table yourself is fine. Put every threshold in `config/lts.json`.

Inputs per edge, best source first:
- **speed**: OSM maxspeed → DRCOG speed limit (conflated) → default by class (residential 25, tertiary 30, secondary 35, primary 40).
- **lanes**: OSM lanes → default by class (residential 2, tertiary 2, secondary 4, primary 4).
- **facility**: Denver ODC → DRCOG inventory → OSM cycleway tags.

Rules v1 (segment only, no intersections yet):
- **LTS 1**: off-street paved path (shared use path, local path, sidepath, highway=cycleway, Trail, Car-Free Street), protected/separated bike lane, or neighborhood bikeway/bicycle boulevard. Also a residential/living_street with speed ≤ 25 and ≤ 2 lanes.
- **Painted or buffered bike lane:** speed ≤ 25 and ≤ 2 lanes → 1 (buffered) / 2 (painted). Speed ≤ 35 and ≤ 4 lanes → 2 (buffered) / 3 (painted). Otherwise 3 (buffered) / 4 (painted).
- **Mixed traffic:** speed ≤ 25 and ≤ 3 lanes → 2. Speed 30 and ≤ 2 lanes → 2 (residential/unclassified) or 3 (others). Speed ≥ 35 or ≥ 4 lanes → 4. Everything else → 3.
- Unpaved paths are flagged `surface: unpaved` and excluded from skate scoring (still shown for bikes).
- Output per edge: `lts`, `lts_inputs` (speed + source, lanes + source, facility + source) so the popup can explain it.

Spot checks (add to `npm run check-lts`): Colfax Ave → 4. Speer Blvd → 4. Broadway protected-lane blocks → 1. Cherry Creek Trail → 1 (path). A typical local residential street in Washington Park → 1. Report the LTS share of total length per city.

## Step 4: bike facilities layer
Unified `facility` enum: `protected_lane | buffered_lane | painted_lane | neighborhood_bikeway | shared_use_path | sidepath | shared_lane | paved_shoulder | unpaved_path`.
Source priority: Denver ODC (in Denver) → DRCOG inventory → OSM tags. Keep `facility_source` and `install_year` where known.

**Paths that don't follow streets** (Cherry Creek, South Platte, High Line Canal, etc.) are among the best places to skate. Include `highway=cycleway/path` OSM edges and the DRCOG path segments as edges in the network, with `surface` so unpaved ones can be hidden.

## Step 5: map
- Layer switcher: **Smoothness** (default, bands) · **Traffic stress** (LTS 1–4, cool→hot ramp) · **Bike facilities** (styles: protected = thick solid, buffered = solid with halo, painted = solid thin, neighborhood bikeway = dashed, paths = distinct path color, unpaved = dotted grey).
- Facilities can also show as an **overlay toggle** on top of Smoothness.
- Stretch: **"Good to ride" filter**, i.e. band ≥ good AND LTS ≤ 2. This is the view riders will want most.
- Popup gains: LTS with its reasons ("25 mph · 2 lanes · neighborhood bikeway"), facility type, and OSM way link.
- Attribution: "© OpenStreetMap contributors · Denver, Aurora, Lakewood, DRCOG, CDOT open data".

## Output size
The metro edge network will be ~150k+ edges, which is too much for one GeoJSON. Build **PMTiles with `tippecanoe`** in Actions (one tileset with all layers' attributes) and load with the `pmtiles` MapLibre protocol. Confirm GitHub Pages serves HTTP range requests for the .pmtiles file. If it doesn't, put the file on Cloudflare R2 (free tier) and tell Kevin before creating an account.

## Done when
- Match report: ≥ 90% of pavement length matched for the 3 cities, unmatched list reviewed.
- LTS spot checks pass. Per-city LTS distribution printed.
- Map has Smoothness / Traffic stress / Bike facilities layers on the OSM network, plus the "Good to ride" filter, served as PMTiles on GitHub Pages.
- README sections: "How streets are combined (conflation)", "How traffic stress is calculated", "Data sources & licenses".

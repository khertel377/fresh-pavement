# Fresh Pavement

Map of Denver-metro street surface quality for skateboarders and EUC riders — where it's freshly paved, where it's smooth, what's coming.

**Live site:** (Vercel URL goes here once deployed)

## Quick start

Requires Node 18+. No npm install needed — zero external dependencies.

```bash
npm run fetch    # download from ArcGIS → data/normalized/
npm run build    # merge + score → public/data/segments.geojson
npm run preview  # serve public/ at http://localhost:3000
```

`fetch` is blocked on Claude's sandbox and the Cowork VM. Run it on your Mac or let GitHub Actions do it.

To re-fetch a single city:

```bash
node scripts/fetch.js denver
node scripts/fetch.js aurora
node scripts/fetch.js lakewood
```

## How data flows

```
ArcGIS REST services
        ↓  npm run fetch
data/normalized/{denver,aurora,lakewood}.ndjson   ← committed, sorted, diffable
        ↓  npm run build
public/data/segments.geojson                      ← committed, served by Vercel
        ↓  browser
public/index.html
```

`data/normalized/` files are sorted NDJSON so `git diff` shows exactly which segments changed each month (e.g. "segment X flipped to done").

`data/.meta.json` caches the ArcGIS `editingInfo.lastEditDate` per source. Delete it to force a full re-fetch.

## How the skate score works

Scores are 0–100. Constants are in `config/score.json` and will be tuned once riders give feedback.

**Treatment wins** (if a resurfacing treatment is on record and not crack seal / reclamite):

| Treatment | Base | Decay/yr |
|-----------|------|----------|
| Mill & overlay / Reconstruct | 100 | 7 |
| HIPR | 85 | 8 |
| Concrete repair | 55 | 3 |
| Slurry seal | 45 | 5 |
| Chip seal | 20 | 2 |

Score = max(5, base − decay × age)

**Else condition index** (PCI/OCI 0–100). If IRI (in/mi) is also available, the two scores are averaged. IRI scale: ≤60 → 100, 95 → 80, 170 → 40, ≥250 → 10.

**Else null** — unscored streets show dim on the map.

## How to add a source

1. Add an entry to `config/sources.json`.
2. Create `scripts/adapters/<id>.js` exporting a `normalize(feature)` function that returns a record matching the schema in `BRIEF.md`, or `null` to skip.
3. Register the source in `scripts/fetch.js` (SOURCES array) and `scripts/build.js` (SOURCES array).
4. Run `npm run fetch -- <id>` then `npm run build` to test.

## Normalized record schema

```json
{
  "id": "denver:12345",
  "source": "denver",
  "name": "N FRANKLIN ST",
  "from": "E COLFAX AVE",
  "to": "E 16TH AVE",
  "last_treatment": { "type": "hipr", "year": 2026, "date": null },
  "planned": { "type": "mill_overlay", "year": 2029 },
  "condition": { "index": "PCI", "raw": 72, "score": 72, "date": "2025-06-01", "iri": 110 },
  "skate_score": 85,
  "geometry": { "type": "LineString", "coordinates": [[...]] }
}
```

Treatment vocabulary: `mill_overlay | reconstruct | hipr | chip_seal | slurry_seal | crack_seal | reclamite | concrete | other`

## Deploying

Vercel serves `public/` as a static site. `vercel.json` sets `outputDirectory: "public"`.

GitHub Actions (`.github/workflows/refresh.yml`) runs `fetch` + `build` on a monthly schedule and on manual dispatch, then commits the updated data. Vercel redeploys on push automatically.

See `BRIEF.md` for full background and phase 2+ plans.

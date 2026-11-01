# Ingest jobs

## Storms and hazards jobs (workstream D)

Two independent uv projects (Python >= 3.10). Outputs follow `docs/CONTRACTS.md` sections 2 and 3.
All writes are atomic (temp file + rename, mode 0644) and the pointer file (`storms/index.json`,
`hazards/index.json`) is always written **last**. Default output directory is the repo's
`public-data/`; override with `--out`.

### Storms: `services/ingest/storms`

```bash
cd services/ingest/storms
uv sync
export STORMTRACK_DATA_DIR=/path/to/stormtrack/data   # optional: use a local checkout's committed IMD/IBTrACS data instead of downloading from GitHub
uv run ingest-storms --out ../../../public-data              # everything
uv run ingest-storms --only active --out <dir>               # live part only (cron)
uv run ingest-storms --only history --out <dir>              # history + stats (monthly/occasional)
uv run ingest-storms --upload                                # also push to Cloudflare R2 (see below)
uv run pytest                                                # offline tests; add -m network for live ones
```

Options: `--basin NI` (default; history/stats basin), `--only {all,active,history}`, `--cache-dir`
(default `~/.cache/stormtrack-web`), `--cone-years 2`, `--no-cone`, `--upload`, `-v`.

| file | contents |
|---|---|
| `storms/active.geojson` | active NHC (al/ep/cp) and JTWC (io/sh/wp, via the UCAR mirror) systems: `position`, `track`, `forecast`, `cone` features |
| `storms/history/NI.geojson` | all IBTrACS North Indian Ocean storms with >= 2 fixes as simplified (Multi)LineStrings |
| `storms/stats/NI.json` | annual counts by strength, monthly climatology, RI events, top-100 lifetime maxima, ACE, caveats in `notes` |
| `storms/index.json` | pointer + provenance (`active.storms`, `active.forecast_unavailable`, `history.<basin>`) |

Design notes and caveats:

- **Winds** are 1-minute (NHC/JTWC) on active storms (`wind_period_min: 1`). The NI history uses the
  IBTrACS merged wind (IMD 3-minute where available, else JTWC 1-minute); `stats.notes` says so. No
  conversion is applied.
- **Forecasts**: NHC `OFCL` via `get_forecast`. JTWC forecast (`.fst`) mirrors are normally unreachable
  (DNS failure / HTTP 403); the forecast and cone are then simply omitted and the storm is listed in
  `index.active.forecast_unavailable`. A failed agency never fails the run; it is recorded in
  `index.active.failed_sources`. If *every* requested component fails, nothing is written and the exit status is 1.
- **Cone** is *our estimate*, not NHC's published cone: the 67th percentile of NHC official (OFCL)
  track errors from the last `--cone-years` (default 2) completed seasons of AL/EP/CP storms (a-decks scored
  against their best tracks with `stormtrack.verification`), pooled over >= 30 forecasts per lead time. The
  sample size and years are written to the `basis` property of each `cone` feature. Circles of those radii are
  swept along the forecast (segment convex hulls, unioned). Only NHC forecasts get a cone.
  Per-storm error tables are cached under `--cache-dir` (finished seasons never change), so only the first run
  is slow (about 25 minutes: ~60 multi-MB downloads from `ftp.nhc.noaa.gov`, which truncates long transfers
  and is retried). **In CI, persist `~/.cache/stormtrack-web` with `actions/cache`** (key e.g. `cone-<year>`), or
  the cron would repeat this on every run.
- **History simplification**: Douglas-Peucker at 0.05 deg, coordinates rounded to 2 dp. **Dateline**: tracks that
  cross +-180 are split into a `MultiLineString` with interpolated crossing points (all coordinates stay in
  [-180, 180]; nothing is unwrapped). The same applies to active tracks/forecasts (per-vertex arrays include the
  interpolated crossing vertices) and to cones (MultiPolygon). North Indian storms never cross it.
- NI history has 1718 of the 1762 IBTrACS storms: 44 single-fix systems cannot be drawn as a line.
- **Other basins**: `--basin WP` etc. calls `load_ibtracs(basin=..., source="ncei")`, which downloads a large
  NOAA/NCEI CSV; not exercised by default or by the tests. Stats thresholds/notes are written for NI.

### Hazards: `services/ingest/hazards`

```bash
cd services/ingest/hazards
uv sync
uv run ingest-hazards --out ../../../public-data
FIRMS_MAP_KEY=xxxx uv run ingest-hazards   # adds hazards/fires.geojson
uv run pytest
```

| file | source | notes |
|---|---|---|
| `hazards/events.geojson` | NASA EONET v3 | Point per event at its latest geometry (polygons -> centroid). `status=open` alone is a >5 MB, ~3 minute response of 7000+ stale wildfires, so we request `days=30` (`--eonet-days`) plus the open-volcano list. Categories map to `wildfire/volcano/flood/storm/quake`, everything else `other` (raw EONET id in `category`). |
| `hazards/quakes.geojson` | USGS `2.5_day` feed | `mag`, `depth_km`, `place`. The feed's 2.5 threshold applies to the *rounded* magnitude, so 2.45-2.49 appear; kept as published. |
| `hazards/fires.geojson` | NASA FIRMS (VIIRS S-NPP NRT, 1 day, world) | only with `FIRMS_MAP_KEY` (never hard-coded; the DEMO key does not work). Grid-deduped (0.05 deg, doubled until <= 20k), each cell keeps the max-FRP detection; `frp`, `confidence` (low/nominal/high), `detections`. **Not exercised live** (no key available when written). |
| `hazards/index.json` | | `layers.<name>.{count,source,url,licence,updated}`; a failed layer keeps its previous file and gets `stale: true`; failures are listed under `failed`. |

Every feature carries `source` and `url`; collections carry `licence` / `attribution`. Exit status is 1 only when
every attempted source failed (then `index.json` is not touched).

### Uploading to Cloudflare R2

`--upload` (both jobs) uploads exactly the files written in that run, with `hazards/index.json` /
`storms/index.json` **last**, through boto3 against R2's S3 API. Keys mirror the `public-data/` paths (optionally
under `R2_PREFIX`). Content types: `application/geo+json` / `application/json`; `Cache-Control`: 60 s for
`index.json`, 300 s for `active.geojson`, 1 h otherwise. Environment (no credentials in code):

| var | meaning |
|---|---|
| `R2_ACCOUNT_ID` | builds `https://<id>.r2.cloudflarestorage.com` |
| `R2_ENDPOINT` | optional full endpoint override (instead of the account id) |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | R2 API token (object read & write on the bucket) |
| `R2_BUCKET` | bucket name |
| `R2_PREFIX` | optional key prefix |

### Commands for the scheduled GitHub Action (workstream E)

```yaml
- uses: astral-sh/setup-uv@v5
- uses: actions/cache@v4            # cone error samples (large first-run cost)
  with: { path: ~/.cache/stormtrack-web, key: cone-${{ github.run_id }}, restore-keys: cone- }
- name: Storms (live)               # cron every 30 min
  working-directory: services/ingest/storms
  run: uv run ingest-storms --only active --out ../../../public-data --upload
  env: { R2_ACCOUNT_ID: ${{ secrets.R2_ACCOUNT_ID }}, R2_ACCESS_KEY_ID: ${{ secrets.R2_ACCESS_KEY_ID }}, R2_SECRET_ACCESS_KEY: ${{ secrets.R2_SECRET_ACCESS_KEY }}, R2_BUCKET: ${{ vars.R2_BUCKET }} }
- name: Hazards                     # cron every 30 min
  working-directory: services/ingest/hazards
  run: uv run ingest-hazards --out ../../../public-data --upload
  env: { FIRMS_MAP_KEY: ${{ secrets.FIRMS_MAP_KEY }}, R2_ACCOUNT_ID: ..., R2_ACCESS_KEY_ID: ..., R2_SECRET_ACCESS_KEY: ..., R2_BUCKET: ... }
```
History + stats change rarely: run `ingest-storms --only history --upload` monthly (or on library data updates).
Since `stormtrack` is not on PyPI yet, `services/ingest/storms/pyproject.toml` points at a local checkout via
`[tool.uv.sources]`; in CI replace it with a git source, e.g. `stormtrack = { git = "https://github.com/atmospy/stormtrack" }`
(or `uv add "stormtrack[xarray] @ git+https://github.com/atmospy/stormtrack"`), and drop `STORMTRACK_DATA_DIR`
(the library then downloads its datasets from GitHub). Note the `--only active` run does not touch the history entry in
`storms/index.json` (it is carried over from the existing index; in CI, download the previous `index.json` from R2 first
or run `--only all` once so it exists).

### Storms history for all basins (Round 2)

```bash
cd services/ingest/storms
uv run ingest-storms --only history --basin all  --out ../../../public-data   # NA,EP,WP,NI,SI,SP,SA
uv run ingest-storms --only history --basin WP,SP --out ../../../public-data   # subset; others are kept
```
Writes `storms/history/<basin>.geojson`, `storms/stats/<basin>.json`, `storms/history/all-index.json` (basin
picker index) and, last, `storms/index.json`. A basin that fails to download is logged and skipped (the others
still publish; the previous entry for it stays in the index). Exit code is 1 only if every basin failed.

IBTrACS cache: NI comes from the library's pre-parsed dataset (no download). Every other basin downloads its own
NCEI CSV once (`ibtracs.<BASIN>.list.v04r01.csv`; NA 58 MB, EP 47 MB, WP 115 MB, SI 78 MB, SP 36 MB, SA 56 kB;
the 330 MB ALL file is never used) into `--ibtracs-cache-dir` (default `<--cache-dir>/ibtracs`, i.e.
`~/.cache/stormtrack-web/ibtracs`). Persist that directory between CI runs with `actions/cache`, e.g.
`path: ~/.cache/stormtrack-web/ibtracs`, `key: ibtracs-v04r01-${{ github.run_id }}`, `restore-keys: ibtracs-v04r01-`
(IBTrACS is refreshed by NCEI weekly; delete the cache or bump the key monthly to pick up new seasons).
Run history monthly, not on the 30-minute cron: the cron should call `ingest-storms --only active`.

## Lightning job (workstream D2)

`services/ingest/lightning`: a uv project (package `lightning_ingest`, CLI `ingest-lightning`), output per
`docs/CONTRACTS.md` section 6. Dependencies are wheel-only (`numpy`, `h5py` which bundles libhdf5, `shapely`,
`boto3`): no system libraries, no eccodes-style surprises.

```bash
cd services/ingest/lightning
uv sync
uv run ingest-lightning --out ../../../public-data -v          # writes <out>/lightning/{flashes.json,coverage.geojson,index.json}
uv run ingest-lightning --out /tmp/pub --prev-url https://data.example.com   # stateless CI: previous output read from the CDN
uv run ingest-lightning --upload                                 # also push to Cloudflare R2 (same R2_* env vars as storms)
uv run pytest                                                    # offline; `-m network` downloads a few live files
```

Options: `--window-minutes 60`, `--max-rows 100000`, `--satellites G16,G18,G19` (candidates; see below),
`--keep-degraded`, `--prev-url`, `--upload`, `-v`. Exit status is 1 only if nothing could be produced
(no previous output and no usable source).

How it works:

- **Source**: NOAA GOES GLM Level-2 LCFA on the public `noaa-goes16/18/19` AWS buckets (anonymous HTTPS, one ~450 kB
  file per 20 s). **Operational satellites are detected, not hard-coded**: every run lists the candidates and uses
  those whose newest file is at most 30 minutes old. On 2026-11-01 that was **G18 (GOES-West, 137.0 W) and
  G19 (GOES-East, 75.2 W)**; the `noaa-goes16` bucket has no data after 2025-04-07 (GOES-16 was retired from
  operations) and is skipped automatically. Unused candidates are named in `index.notes`.
- **Incremental**: the previous `flashes.json`/`index.json` (output dir, else `--prev-url`) are loaded; the per-satellite
  cursor of the last file processed is kept in `index.state` (additive field). Only newer files are downloaded (8 threads),
  parsed in memory with h5py (15 files in ~0.1 s), appended, and anything older than the window is dropped. A cold start
  downloads only the last window (about 360 files, ~100 MB, so run it once, then incrementally). A file whose download
  fails is retried next run.
- **Quality**: `flash_quality_flag == 0` only (1/3/5 = degraded: events out of time order, event-count or duration over
  threshold); fill-valued energies and non-finite coordinates are dropped. Energies are published in fJ (the file stores
  J, packed in uint16, so the resolution is 1 fJ). Flash time = `flash_time_offset_of_first_event` decoded with its
  `scale_factor`/`add_offset` (unsigned) from the epoch in its `units` attribute.
- **Overlap rule** (GOES-East and West both see central America / the Pacific / the Atlantic): a flash is kept only from the
  satellite whose sub-satellite longitude is nearest to the flash longitude (best geometry), so no flash is counted by
  both. Within about one parallax (~0.3 deg) of the midpoint (~106 W) a flash may be dropped or doubled.
- **Cap**: > `--max-rows` is handled by thinning with a deterministic hash of each flash's published (time, lon, lat), so the
  sample is uniform in time, stable from run to run (a kept flash stays kept), and the sampling fraction is stated in
  `index.notes`. The real hourly total (~130k) exceeds the cap, so in practice about 60-70% of flashes are shown.
- **Coverage footprint** (`coverage.geojson`, labelled `approximate: true`): union of 52-degree great-circle caps around
  each used satellite's sub-satellite point. NOAA ("coverage up to 52 N", <https://www.goes-r.gov/spacesegment/glm.html>)
  and NASA (<https://lightning.nsstc.nasa.gov/overview_glm.html>, 52 N/S from GOES-East) state ~52 deg; Rudlosky et al. 2019
  (GRL, doi:10.1029/2018GL081052) say 54 deg; the pixel growing from 8 km (nadir) to 14 km (edge) fits a ~52-54 degree
  great-circle radius. About 0.5% of detections lie just outside the 52 degree cap, so the edge is soft.
- **Stale / failure**: if the newest file is older than 10 minutes or listing fails, the previous files are republished
  untouched with `index.stale: true`; an empty file is never published because a download failed.
- **Upload**: `flashes.json` and `index.json` get `public, max-age=30, stale-while-revalidate=60`, `coverage.geojson`
  `max-age=3600`; `index.json` is uploaded last. Env vars as in `storms_ingest.upload`.

### The South Asia gap (candidate sources)

There is **no open real-time lightning source for South Asia**. GLM does not see it (it covers the Americas and adjacent
oceans). Candidates:

| source | used? | why |
|---|---|---|
| NOAA GOES GLM (G18/G19) | **yes** | open, public domain, 20 s cadence, Americas / Atlantic / eastern Pacific |
| EUMETSAT MTG Lightning Imager (MTG-I1) | **later** | free after registering for an EUMETSAT Data Store key; covers Europe, Africa, Middle East, Atlantic; it does not reach South Asia. Extension point: `src/lightning_ingest/sources/` (implement the `Source` protocol, register in `default_sources`) |
| Blitzortung | no | terms forbid commercial / warning use and the project states there is no external API |
| Nowcast **LINET** (what Windy.com uses) | **not without a licence** | commercial global network run by Nowcast.de (Munich); Windy switched to it from Blitzortung on 2023-10-06 under an undisclosed partnership; global with minor ocean gaps, seconds-to-tens-of-seconds delay; sold on request, with no public price or API. Add via the `sources/` extension point once licensed |
| IITM lightning location network (India) | **not without an agreement** | 83 sensors (Lok Sabha answer, 2021), shared with IMD and states. The Damini Android app (com.lightening.app.damini 1.0.2, Flutter) reads from an **IITM-owned server** (`daminiapp.tropmet.res.in`, IP block registered to IITM-PUNE) over plain HTTP; the endpoint is undocumented and has no published terms. Do not use it in the product without written permission from IITM Pune / MoES |
| WWLLN (Univ. of Washington) | **not without an agreement** | research use only at 10-minute cadence; faster data via an unnamed commercial reseller; no explicit commercial terms found |
| FengYun-4 Lightning Mapping Imager (China) | **unverified** | satellite at 105°E watching China and surroundings; access conditions and real-time delivery not confirmed |
| Himawari / FY-4 GHI-LMI / GK-2A | not used | no open real-time lightning product with a stable public feed that we could verify |
| commercial networks (Vaisala, Earth Networks, WWLLN) | not used | licensed / paid |

The UI must therefore always show the footprint and never imply "no lightning" outside it.

### Lightning: optional IITM Pune "Damini" feed for India (UNOFFICIAL) and the live loop

**Status: prototype only. Do not launch publicly without written permission from IITM Pune / the Ministry of Earth Sciences.**
The feed is unofficial and undocumented, has no published licence or terms, is served over plain HTTP, and can change or
disappear at any time. A changed page makes the source report an error and publish no strikes (never garbage); the other
sources keep publishing.

- **Enable (opt-in):** `uv run ingest-lightning --source goes-glm,iitm-damini` (repeatable or comma list) or
  `LIGHTNING_SOURCES=goes-glm,iitm-damini`. Default is `goes-glm` only. `.github/workflows` is not wired for it.
- **What it is:** `GET http://103.251.184.43/json/india.php` (host registered to IITM-PUNE, reverse DNS
  `daminiapp.tropmet.res.in`) returns an HTML page (Leaflet map, ~9 kB) with an inline
  `const lightningData = [{"lat":"17.9333","lng":"94.1774","label":"10min"}, ...];`. lat/lng are strings (4 dp);
  `label` is `5min`/`10min`/`15min`. No per-strike time, energy or polarity. ~117 strikes spanning lat 8-35, lon 71-98 in one
  snapshot. CORS `*`, Apache.
- **Time model (assumption, unverified):** `label` is an age bucket ("within 5 min", "5-10", "10-15"). Cold start: bucket
  midpoints (2.5/7.5/12.5 min before our fetch time). Once a previous successful poll exists, each newly seen strike gets a
  deterministic time spread between that poll and now, constrained to its bucket. `time_precision: "bucketed"`,
  `time_uncertainty_s: 150`; clients must not show exact times. Energy is `null`.
- **De-duplication:** strikes persist across snapshots as they age; a strike with identical lon/lat (4 dp) and a time within
  16 min of an already published row of this source is the same strike (the earlier row stays).
- **Polling policy:** one request per poll, 15 s timeout, 2 MB cap, `User-Agent: stormtrack-web-ingest (+https://github.com/atmospy/stormtrack-web)`,
  at most one retry (5 s later) after a network error (none after an HTTP error), and an enforced minimum interval between
  requests (default and floor 60 s, `--iitm-min-interval-s`; kept in `index.state["iitm-damini"]`). A poll sooner than that
  makes no request. A failed attempt also restarts the interval.
- **Coverage:** one approximate rectangle (about lon 66-100, lat 5-38, widened with margin if strikes fall outside),
  `basis: "extent of strikes reported by the feed; not a sensor-coverage map"`.
- **Open questions:** (1) exact bucket semantics; (2) the server clock was ~5.5 min ahead in one response: the `Date` header
  vs local time is recorded as `state.clock_skew_s` but never used for ordering; (3) true event-to-feed latency; (4) whether
  strikes can be revised/removed between snapshots.
- **Failure isolation / staleness:** each source has its own `stale`/`updated`; top-level `stale` = all sources stale. A failing
  source keeps its previous rows only until the window expires. Reading a previous 4-column file is treated as a cold start.

**Live mode (CONTRACTS 6.2).** Every run also writes `lightning/recent.json` (last 90 s, `--recent-window-s`; cap 4000, thinning
only high-volume sources) before `index.json`, and `index.json` has `live: {delay_s, poll_s}`.
`ingest-lightning --loop [SECONDS]` (default 20) repeats the run until Ctrl-C/SIGTERM, with exponential error backoff
(max 300 s); GLM downloads only new files each cycle, IITM is still limited by its 60 s floor. With `--upload` each cycle uploads
`recent.json` (`max-age=10`) and `index.json`; `flashes.json` and `coverage.geojson` every `--upload-full-every-s` (300 s).
Without `--loop` a single run is performed (CI).

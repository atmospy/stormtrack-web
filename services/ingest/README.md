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

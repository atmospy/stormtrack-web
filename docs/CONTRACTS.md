# Data contracts

All data products are static files under `public-data/` (served in dev at `/data/...` via
`apps/web/static/data → public-data`; in production from the CDN/R2 at `PUBLIC_DATA_BASE`).
Producers write **atomically** (write temp, rename) and **last** write the pointer file
(`latest.json` / `index.json`) so consumers never see a half-published run. All times are UTC
ISO-8601 with a trailing `Z`. Speeds: wind in **m/s** in wind files, **knots** for storms.
Longitudes are `-180..180`, latitudes `-90..90`.

## 1. Wind (producer: B · consumers: C, A)

```
public-data/wind/latest.json
public-data/wind/<run>/f<FFF>.png        # run = YYYYMMDDTHH (e.g. 20261101T00); FFF = forecast hour, 3 digits
```

`latest.json`:
```json
{
  "schema": 1,
  "source": "NOAA GFS 0.25°",
  "licence": "US Government work, public domain",
  "level": "10m",
  "units": "m/s",
  "run": "2026-11-01T00:00:00Z",
  "generated": "2026-11-01T05:12:09Z",
  "image": {
    "width": 720, "height": 361,
    "lon_left": -180, "lon_right": 179.5,
    "lat_top": 90, "lat_bottom": -90,
    "u": {"min": -50, "max": 50},
    "v": {"min": -50, "max": 50},
    "speed_max": 70
  },
  "frames": [
    {"fhr": 0, "valid": "2026-11-01T00:00:00Z", "png": "wind/20261101T00/f000.png", "bytes": 312345}
  ]
}
```

PNG encoding (8-bit RGBA, no gamma/colour-profile, lossless, fully opaque):
- `R = round((u - u.min) / (u.max - u.min) * 255)`
- `G = round((v - v.min) / (v.max - v.min) * 255)`
- `B = round(min(speed, speed_max) / speed_max * 255)`  (redundant convenience channel)
- `A = 255`
- Row 0 is `lat_top` (north); column 0 is `lon_left`. Equirectangular, grid spacing
  `(lon_right - lon_left) / (width - 1)`. Values are *not* pre-multiplied or smoothed.
- `png` paths are relative to the data root (so `"<base>/" + png`).

Frames: forecast hours 0–72 every 3 h at minimum (more later). Default grid 0.5°
(720×361); the contract is resolution-agnostic — consumers must read `image` and never hard-code sizes.

## 1b. Weather fields v2 — models, levels, scalars (producer: weather ingest · consumers: web app)

Supersedes §1 for new work. §1 (`wind/latest.json`, GFS 10 m wind) **keeps being written** as a
compatibility alias until the app has migrated; do not remove it.

```
public-data/weather/index.json                         # catalogue of models
public-data/weather/<model>/latest.json                # per-model pointer, written last
public-data/weather/<model>/<run>/<field>/fFFF.png     # run = YYYYMMDDTHH ; field slug e.g. wind_10m, wind_850, mslp, t2m, precip
```
`<model>` ids: `gfs`, `ecmwf-ifs`, `ecmwf-aifs`. A model may provide only some fields; consumers must
read what `latest.json` lists, never assume.

`index.json`: `{"schema":2,"generated":"…Z","models":[{"id":"gfs","name":"NOAA GFS 0.25°","licence":"…","run":"…Z","latest":"weather/gfs/latest.json"}]}`

`<model>/latest.json`:
```json
{"schema":2,"model":"gfs","run":"2026-11-01T12:00:00Z","generated":"…Z",
 "grid":{"width":720,"height":361,"lon_left":-180,"lon_right":179.5,"lat_top":90,"lat_bottom":-90},
 "fields":[
  {"id":"wind@10m","slug":"wind_10m","kind":"vector","units":"m/s","level":{"type":"height_agl","value":10,"label":"10 m"},
   "range":{"u":[-50,50],"v":[-50,50],"speed_max":70},"frames":[{"fhr":0,"valid":"…Z","png":"weather/gfs/20261101T12/wind_10m/f000.png","bytes":312345}]},
  {"id":"wind@250hPa","slug":"wind_250","kind":"vector","units":"m/s","level":{"type":"pressure","value":250,"label":"250 hPa"},
   "range":{"u":[-100,100],"v":[-100,100],"speed_max":140},"frames":[…]},
  {"id":"mslp","slug":"mslp","kind":"scalar","units":"hPa","range":[930,1070],"frames":[…]},
  {"id":"t2m","slug":"t2m","kind":"scalar","units":"°C","range":[-60,60],"frames":[…]},
  {"id":"precip","slug":"precip","kind":"scalar","units":"mm per frame interval","range":[0,100],"transform":"sqrt","frames":[…]}
 ]}
```
- **Vector fields** use the §1 encoding (8-bit R=u, G=v, B=speed) with the `range` of that field.
- **Scalar fields** use **16-bit** packing so isobars are smooth: `v16 = round((x - min)/(max - min) * 65535)`,
  `R = v16 >> 8`, `G = v16 & 255`, `B = 0`, `A = 255` (PNG, lossless, no gamma/colour profile).
  If `transform` is `"sqrt"` (precipitation): `range` is still in **physical units** and
  `v16 = round((sqrt(x) - sqrt(min)) / (sqrt(max) - sqrt(min)) * 65535)`; decode
  `x = (sqrt(min) + v16/65535 * (sqrt(max) - sqrt(min)))²`. (So precip `[0,100]` means 0–100 mm.)
- Precipitation is the **depth accumulated over the interval ending at the frame's valid time** (frame 0 is zeros).
- All fields in a model share one `grid`; frames share the same `fhr` list per field where possible.
- Pressure-level winds required in round 2: 850, 700, 500, 300, 250 hPa (+ 10 m).

## 2. Storms (producer: D · consumers: A)

```
public-data/storms/index.json                 # pointer + provenance
public-data/storms/active.geojson             # currently active systems (NHC, JTWC)
public-data/storms/history/<basin>.geojson    # one simplified LineString per historical storm
public-data/storms/stats/<basin>.json         # precomputed climatology/analysis for the basin
```
Basins use IBTrACS codes (`NI`, `WP`, `EP`, `NA`, `SI`, `SP`, `SA`); M0 requires **`NI`**.

`index.json`: `{ "schema":1, "generated":"…Z", "active": {"count":2,"updated":"…Z","sources":["NHC","JTWC"]}, "history": {"NI": {"count":1762,"year_min":1842,"year_max":2025,"sources":["IMD","IBTrACS"]}} }`

`active.geojson` is a `FeatureCollection`; every feature has `properties.kind`:
- `"position"` — Point, current/latest fix. Props: `id` (ATCF id, e.g. `IO042026`), `name` (nullable),
  `basin`, `agency` (`NHC`|`JTWC`), `time`, `wind_kt`, `pressure_hpa` (nullable), `category`
  (`{"scale":"saffir-simpson","label":"TS"}`), `heading_deg` (nullable), `speed_kmh` (nullable).
- `"track"` — LineString of observed best-track positions; same `id`; per-vertex arrays in
  `properties.times` (ISO list) and `properties.wind_kt` (list, null when unknown).
- `"forecast"` — LineString of forecast positions; props `init`, `tech`, `taus` (hours list),
  `wind_kt` (list), `category` (list of labels).
- `"cone"` — Polygon (or MultiPolygon) of the uncertainty cone (67 % circles, see
  `stormtrack.verification`); props `id`, `radii_km`, `basis` (text saying where radii came from).
Wind averaging: NHC/JTWC are 1-minute; always add `"wind_period_min": 1` to `position`.

**Clarifications (decided after M0, binding for producers and consumers):**
- Every `forecast` feature carries the storm `id` (as `position`, `track` and `cone` do); consumers must key on `id`, not geometry.
- `cone.properties.radii_km` is a list aligned index-for-index with a `taus` list (hours) on the same feature.
- Geometries that cross the antimeridian are emitted as `MultiLineString` / `MultiPolygon` (split at ±180, coordinates stay in `-180..180`); a `LineString` / `Polygon` is the single-part case. Consumers must accept both.
- Producers may add extra properties; consumers must ignore unknown ones. Required properties above may not be removed or renamed without bumping `schema`.
- `annual[].tropical_storm|hurricane|major` in stats are plain wind thresholds (34 / 64 / 96 kt of lifetime maximum), **not** IMD grades.
- Forecast/cone are omitted (and the id listed in `index.active.forecast_unavailable`) when an agency forecast cannot be fetched; the UI must treat them as optional.

`history/<basin>.geojson`: LineString per storm; props `id`, `name` (nullable), `year`,
`max_wind_kt` (nullable), `category` (Saffir–Simpson label of the peak, nullable), `imd_grade`
(nullable, e.g. `"SCS"`), `start`, `end`. Coordinates rounded to 2 decimals. Target ≤ 1.5 MB gzip.

`stats/<basin>.json`: `{ "annual": [{"year":2019,"storms":9,"tropical_storm":6,"hurricane":3,"major":1,"ace":12.3}],
"monthly": [{"month":1,"storms_per_year":0.2}], "rapid_intensification": [{"id":"…","name":"…","year":2019,"max_dwind_kt_24h":45}],
"lifetime_max": [{"id":"…","name":"…","year":2019,"wind_kt":115,"lat":19.0,"lon":87.0}], "notes":"…" }`.
Numbers come from `stormtrack.analysis` (see its docs); put caveats (agency wind averaging, the
satellite-era cut-off) in `notes`.

**Round 2 (all basins; additive, nothing above is removed or renamed):**
- History and stats exist for all seven IBTrACS basins: `NA`, `EP`, `WP`, `NI`, `SI`, `SP`, `SA` (basin = the storm's *genesis* basin, so a track may leave its basin). `history/<basin>.geojson` features gain `properties.basin`; `stats/<basin>.json` gains `basin`, `name`, `monthly_period` (`[1980, last_year]`, the monthly climatology is satellite-era only) and a per-basin honest `notes` text (agency wind averaging, missing early intensities, provisional latest season, Saffir-Simpson thresholds applied to whatever `wind` the record carries). `category`/`tropical_storm|hurricane|major` therefore mean "wind thresholds on that basin's agency winds", not a like-for-like intensity across basins.
- `index.json` `history.<basin>` gains `name`, `file` (`storms/history/<basin>.geojson`), `stats` (`storms/stats/<basin>.json`), `bytes` (raw size of the history file) and `gzip_bytes` (level-6 gzip size). A basin appears only if its files exist; consumers must not assume all seven are present. `index.json` is written last; `history/all-index.json` just before it.
- `public-data/storms/history/all-index.json` (tiny, for the basin picker; fetch this, not the big files):
  `{"schema":1,"generated":"…Z","basins":[{"id":"WP","name":"West Pacific","count":2400,"year_min":1884,"year_max":2025,"file":"storms/history/WP.geojson","stats":"storms/stats/WP.json","bytes":1234567,"gzip_bytes":234567}],"total_bytes":N,"total_gzip_bytes":N}`, basins in display order NA, EP, WP, NI, SI, SP, SA. `file`/`stats` are relative to the data root.
- `active.geojson` `basin` uses the same codes (`NA`,`EP`,`WP`,`NI`,`SI`,`SP`,`SA`); Southern-Hemisphere storms are split by genesis longitude (SI 20E-135E, SP 135E-120W, else SA).

## 3. Hazards (producer: D · consumers: A)

```
public-data/hazards/events.geojson     # NASA EONET open events (wildfires, volcanoes, severe storms, floods…)
public-data/hazards/quakes.geojson     # USGS last-24h, magnitude ≥ 2.5
public-data/hazards/fires.geojson      # NASA FIRMS hotspots (only if a FIRMS_MAP_KEY is provided)
public-data/hazards/index.json         # {"schema":1,"generated":"…Z","layers":{"events":{"count":N,"source":"NASA EONET"}, …}}
```
Common props: `id`, `kind` (`wildfire`|`volcano`|`quake`|`flood`|`storm`|`other`), `title`, `time`,
`url` (source page), `source`. Quakes add `mag`, `depth_km`. Fires: aggregate to ≤ 20 k points
(grid-dedupe) with `frp` and `confidence`. Missing keys → skip that file, don't fail the run.

## 4. Supabase (producer: E · consumers: A)

Tables (all in `public`, **RLS on, owner-only** policies keyed on `auth.uid()`):
- `profiles(id uuid pk → auth.users, display_name text, avatar_url text, home_lat float8, home_lon float8, units jsonb default '{}', created_at timestamptz)` — auto-created by a trigger on signup.
- `saved_places(id uuid pk, user_id uuid, name text, lat float8, lon float8, created_at)`
- `saved_views(id uuid pk, user_id uuid, name text, state jsonb, created_at)` — map camera, layers, time.
- `storm_follows(user_id uuid, storm_id text, created_at, pk(user_id, storm_id))`
Auth: email magic link + Google OAuth (config in `supabase/config.toml`; secrets via env, never committed).
Client env: `PUBLIC_SUPABASE_URL`, `PUBLIC_SUPABASE_ANON_KEY`.

## 5. Login gate (behaviour spec, implemented by A)
- Anonymous users get the full homepage. After **3 minutes of active time** (timer pauses while
  the tab is hidden) **or 8 meaningful interactions** (layer toggle, storm click, search, scrub),
  whichever comes first, show a polished **non-blocking** sign-up card ("Create a free account to
  save places, follow storms and unlock analysis"). "Not now" snoozes it for 24 h (localStorage);
  it never hides the map. Constants live in one config module.
- Signed-in-only features (stubbed in M0): save place/view, follow storm, run analysis export.
- The gate is a prompt, not security — protected data stays behind RLS.


## 6. Lightning (producer: lightning ingest · consumer: web app)

```
public-data/lightning/index.json        # pointer + provenance + coverage, written last
public-data/lightning/flashes.json      # recent flashes, compact column form
public-data/lightning/coverage.geojson  # footprint where the source can see lightning (Polygon/MultiPolygon)
```
`index.json`: `{"schema":1,"generated":"…Z","updated":"…Z","window_minutes":60,"count":N,
"sources":[{"id":"goes-glm","name":"NOAA GOES GLM (G16/G18/G19)","licence":"NOAA open data (public domain)","satellites":["G19","G18"],
"latency_s":60,"coverage":"lightning/coverage.geojson"}],
"notes":"Coverage: Americas, Atlantic and eastern Pacific. No open real-time lightning feed covers South Asia."}`

`flashes.json`: `{"schema":1,"t0":"2026-11-01T19:00:00Z","cols":["dt_s","lon","lat","energy_fj"],"rows":[[0,-84.12,29.4,310.0], …]}`
sorted by time, `dt_s` = seconds since `t0`, lon/lat rounded to 2 dp. Cap ≈ 100 000 rows (decimate
uniformly in time when exceeded and say so in `index.notes`). Missing/stale source → keep the previous files
and set `index.stale: true`; never publish an empty file because a download failed.
Always show the coverage footprint in the UI; never imply "no lightning" where there is no coverage.

**Clarifications from the first implementation (binding):**
- `index.json` also carries `stale` (boolean, always present), `latency_s` (measured) and an internal `state` object
  (per-satellite cursors, sub-satellite longitudes, `keep_fraction`). Consumers must **ignore `state`**.
- `satellites` lists only the satellites actually delivering now (GOES-16 is retired; today G18 West and G19 East).
- Over the row cap the sample is a stable pseudo-random thinning (a kept flash stays kept between runs), **not**
  decimation by time; `index.notes` states the kept fraction. Counts shown to users must say "sampled" when `keep_fraction < 1`.
- `energy_fj` is quantised to 1 fJ. Quality: only GLM `flash_quality_flag == 0` is published.
- `coverage.geojson` is a `FeatureCollection` with one union (Multi)Polygon feature, marked `approximate: true`
  (52° great-circle caps around each satellite; the edge is soft, about 0.5 % of flashes lie just outside it).
- Where two satellites overlap a flash is kept from the satellite nearest in longitude; within ~0.3° of the midpoint a flash may be doubled or dropped once.


## 7. Weather ingest runtime notes
Jobs must run on a clean Linux machine with no system libraries (see the eccodes lesson: declare native
dependencies as wheels), use no absolute local paths, and pass `ruff check` / `ruff format --check` with the repo's `ruff.toml`.

### 6.1 Multi-source lightning (supersedes the 4-column form above; binding)

The lightning dataset can combine several sources (GOES GLM, plus optional regional feeds such as the unofficial IITM "Damini" feed).
- `flashes.json` `cols` is now `["dt_s","lon","lat","energy_fj","src"]`. **Consumers must map columns by the names in `cols`, never by fixed position.**
  `src` is an integer index into `index.sources`. `energy_fj` may be `null` (a source that reports none): draw such strikes at a default size.
  `lon`/`lat` precision varies by source (GLM 2 dp, IITM 4 dp).
- `index.sources[i]`: `{id, name, licence, attribution, kind: "satellite"|"ground-network", time_precision: "exact"|"bucketed",
  time_uncertainty_s, unofficial: bool, latency_s, stale: bool, updated, coverage: "lightning/coverage.geojson", ...}`. Top-level `stale` is true only when **every** source is stale.
- `coverage.geojson` is a `FeatureCollection` with **one feature per source** (`properties.source` = source id, `approximate: true`, `basis` text). "Inside coverage" means inside the union.
- UI rules: show the attribution of every source with strikes in view; label `unofficial: true` sources as "unofficial feed";
  for `time_precision: "bucketed"` strikes the time is an age-bucket midpoint (± `time_uncertainty_s`), so never show an exact timestamp for them.
- Thinning to the row cap applies only to high-volume sources (GLM); regional sources are never thinned.

### 6.2 Live feed for animation + sound (binding)

Lightning is a **live, animated, audible experience**, not a static layer. For that the ingest also publishes a tiny rolling file the browser polls often:

```
public-data/lightning/recent.json     # the last ~180 s of strikes; polled every 10-15 s; Cache-Control max-age 10
```
`{"schema":1,"generated":"…Z","window_s":180,"cols":["id","t_ms","lon","lat","energy_fj","src"],"rows":[["a1b2c3d4",1793560800123,-84.12,29.4,310.0,0],…]}`
- `id` is a stable short hash of `(src, t, lon, lat)`; clients de-duplicate on it across polls. `t_ms` is unix milliseconds (the strike time; for `bucketed` sources an estimate, see below). Columns are read by name. Cap ~4 000 rows (thin the high-volume source if exceeded; never the regional one).
- A source with `time_precision: "bucketed"` assigns each *newly seen* strike a time spread uniformly between the previous successful poll and now (not a fixed bucket midpoint) once a previous poll exists; on a cold start it uses bucket midpoints.
- `index.json` gains `live: {"delay_s": 90, "poll_s": 20}`: the ingest's measured end-to-end latency and its publishing interval. The client plays strikes back at their own timestamps, a fixed `delay_s` behind real time, so every batch has arrived before it is played, and **shows that delay honestly** ("Live, ≈ 1.5 min behind").
- `flashes.json` (60 min of history, §6/§6.1) is still published, at a slower cadence, for initial backfill.

**Client experience (binding):** every new strike produces a short bright flash then an expanding ring and a fading afterglow dot (colour by age); heavy cells must stay legible (cap concurrent animations, prefer higher energy). **Sound** is synthesised in the browser (Web Audio; no audio assets): a crack/rumble per strike, louder and sharper when close to the listener point (the map centre or a pinned place), softer and more rumbling when far, with a stylised distance delay (≈ 1 s per 10 km, capped ~6 s), a voice limit (~24) and a master compressor so storms never clip. Sound is **off by default**, enabled by one click (browser autoplay rules), remembers the choice, has a visible mute button and a keyboard shortcut. Photosensitivity: no full-screen or large-area flashing, at most small point flashes; `prefers-reduced-motion` or a "reduce flashing" setting turns flashes into a gentle fade.

**6.3 Clarifications from the multi-source implementation (binding):**
- `recent.json` covers **180 s** (read `window_s`; do not hard-code). At ~60-80 s feed latency and a 20 s publish cycle a 90 s window would show each strike for only 10-30 s.
- `index.live.delay_s` = slowest source latency + 20 s + `poll_s` (floor 30). The client plays back `delay_s` behind real time and must show it.
- `index.sources[i]` may also carry `lon_lat_dp`, `count`, and `satellites` (satellite sources only); `time_uncertainty_s` is 0 for GLM.
- A source that errors is marked `stale` immediately; its rows are kept only until the window expires.
- With the loop mode's fast-path upload, `index.count` can lag the uploaded `flashes.json` by up to ~5 min: clients treat `recent.json` as authoritative for live playback and `flashes.json` only for backfill.
- A strike re-seen by the IITM feed in a later snapshot is dropped by de-duplication, so it keeps its first (estimated) time and id.

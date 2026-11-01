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

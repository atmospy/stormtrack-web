# StormTrack Web: `apps/web`

SvelteKit (static SPA, `@sveltejs/adapter-static`) + MapLibre GL JS globe + `@stormtrack/wind-layer` + `@stormtrack/scalar-layer` + Supabase.
Opens on a full-screen interactive globe with live wind particles, active cyclones and hazards; model/level/variable selection,
MSLP isobars, a click-anywhere meteogram, lightning, all-basin storm history with filters and shareable links.

## Run

```bash
pnpm install                       # from the repo root
cp apps/web/.env.example apps/web/.env   # optional
pnpm --filter web dev              # http://localhost:5173
pnpm --filter web check            # svelte-check, strict TS
pnpm --filter web test             # vitest (108 tests)
pnpm --filter web build            # static site in apps/web/build (deploy to Cloudflare Pages)
pnpm --filter web sample           # regenerate public-data/sample/** (synthetic, committed)
```

Env (`PUBLIC_*`, read via `import.meta.env`): `PUBLIC_DATA_BASE` (default `/data`), `PUBLIC_SUPABASE_URL`,
`PUBLIC_SUPABASE_ANON_KEY`. Without the Supabase pair the app runs in a labelled **demo mode**.

## Architecture

```
src/lib/config.ts        all constants (data base, login-gate thresholds, playback)
src/lib/data/            contracts.ts (runtime validators), load.ts (fetch + sample fallback), boot.ts, active.ts, cities.ts
src/lib/wind/            adapter.ts (lazy import of @stormtrack/wind-layer)
src/lib/scalar/          adapter.ts (lazy import of @stormtrack/scalar-layer: ScalarLayer, ramps, isobar worker)
src/lib/weather/         select.ts (models/levels/time), pack.ts + sample.ts (CPU grids, bilinear sampling), store.ts (LRU frame store),
                         decoder.ts + decode.worker.ts (fetch+createImageBitmap+pixel read off the main thread), runtime.svelte.ts
                         (what is on screen), series.ts + meteo.svelte.ts (meteogram)
src/lib/lightning/       state.svelte.ts (load, 60 s refresh, counts), player.ts (playback queue for the live feed, injectable clock)
src/lib/history/         state.svelte.ts (basins, filters, "storms near the point")
src/lib/state/           url.ts (pure (de)serialiser), share.svelte.ts (apply/restore/current state)
src/service-worker.ts    versioned cache: immutable frames cache-first, pointer JSON stale-while-revalidate
src/lib/map/             style.ts (custom dark OpenFreeMap style), storms.ts, hazards.ts, arrows.ts
src/lib/auth/            gate.ts (pure login-gate logic), client.ts (lazy supabase-js), auth.svelte.ts (store + stubs)
src/lib/stores/          app.svelte.ts (single app state, runes), gate / toast stores
src/lib/components/      MapView, TopBar, LayerPanel, TimeBar, Readout, Conditions, StormPanel, CommandPalette (lazy), AuthModal (lazy), ...
```

Note: SvelteKit 3 removed `$lib`; the app uses `#lib/*` (package.json `imports` + tsconfig `paths`).

### Round 2 features
- **Fields (CONTRACTS 1b)**: `weather/index.json` -> first model's `latest.json` (others load in the background so the switch is instant).
  Fallback chain: real v2 catalogue -> real legacy `wind/latest.json` (wrapped as a one-field GFS model) -> sample v2 -> sample legacy.
  Controls show only what the catalogue lists: model (GFS / IFS / AIFS), variable (wind, pressure, temp, rain), wind level (10 m, 850, 700,
  500, 300, 250 hPa, labelled "850 hPa ≈ 1.5 km"). One clock (`app.validMs`) drives all; switching keeps the valid time (nearest frame
  otherwise) and the old frames stay on screen until the new ones are decoded (both slots commit together, never an empty map).
  Scalar = `ScalarLayer` colour fill + legend; MSLP adds isobars (package worker, cached per frame) with labels and H/L as MapLibre layers.
- **Meteogram**: click the map (or pick a place / storm in the palette). Wind 10 m with direction arrows, MSLP, 2 m temp, precipitation bars
  over all frames, sampled from the CPU grids in the frame store (2 bytes/px, byte-budgeted LRU, 320 MB). Only the ticked series are
  downloaded; a progress bar shows loading; once cached a new point is a ~1 ms lookup. "Pin" keeps one card while clicks drive another.
- **Lightning**: baseline only (see below). Coverage footprint is always drawn while the layer is on; a notice says when the view centre is
  outside it; data age, `stale`, sampling (`keep_fraction`) and the attribution of every source with strikes in view are shown; unofficial
  sources are labelled; bucketed sources are only ever age-faded. `lightning/player.ts` + `parseRecent` are the plumbing for CONTRACTS 6.2.
- **History**: `storms/history/all-index.json` picks the basins; each basin file is fetched on first tick. One MapLibre source holds every
  loaded basin; basin / year range / minimum category / "near the clicked point" are `setFilter` + paint expressions (no data re-adds).
  Southern basins are labelled "2026-27" seasons. MultiLineString (antimeridian) tracks are accepted.
- **Share links**: `?c=lat,lon,zoom&m=model&f=variable&l=level&t=YYYYMMDDTHH&ov=1&on=layers&s=a:ID|h:ID&lw=15&pin=lat,lon&hb=NA,WP&hy=1990-2020&hc=3`,
  written with a debounced shallow `goto(..., { replace: true })` (no history entries), restored on load, validated (garbage is ignored).
  "Copy link to this view" is in the palette (Cmd/Ctrl+K).
- **Speed**: the next 3 frames of each active field are decoded ahead while playing; adjacent levels and the other models are warmed on idle
  (HTTP/SW cache only); the service worker caches run-stamped frame PNGs cache-first and pointer JSON stale-while-revalidate.

### How each contract is consumed
- **Wind (§1)**: `wind/latest.json` is validated (`parseWindLatest`), frames are lazily fetched as PNG, decoded with
  `createImageBitmap(..., colorSpaceConversion:'none', premultiplyAlpha:'none')`, and handed to the wind layer. The next
  frame is preloaded (2 ahead, LRU of 6) and passed as `nextImage` + `mix` so playback blends smoothly between frames.
  Sizes are never hard-coded: everything comes from `image`.
- **Storms (§2)**: `storms/active.geojson` is validated and flattened into three GeoJSON sources (lines, points, history).
  Positions get a pulsing glow coloured by Saffir-Simpson category, observed track with per-vertex wind colouring, dashed
  forecast with `+Nh` labels, translucent cone. `storms/history/NI.geojson` is lazy (fetched when toggled or searched);
  clicking a historical line highlights it. `storms/stats/NI.json` feeds the climatology bar chart (only requested for basins
  listed in `storms/index.json`).
- **Hazards (§3)**: `hazards/index.json` decides which files are requested; unlisted/404 layers are disabled (greyed, no
  further requests). Events are clustered with canvas-drawn icons per `kind`, quakes are magnitude-scaled circles, fires are a
  heatmap that turns into dots at zoom >= 5. Popups are built with DOM APIs (feed text is untrusted); only http(s) links.
- **Supabase (§4)**: `auth.savePlace`, `saveView`, `toggleFollow` write to `saved_places`, `saved_views`, `storm_follows`.
  `supabase-js` is imported lazily, and eagerly only when a stored session / OAuth return is detected.
- **Login gate (§5)**: `src/lib/auth/gate.ts` (pure, unit tested). 3 min of visible-tab time or 8 interactions; "Not now"
  snoozes 24 h in `localStorage`; the card never blocks the map; signed-in users never see it. Constants: `GATE` in `config.ts`.

### Data fallback
Every pointer file is tried at `PUBLIC_DATA_BASE` first, then `/data/sample` (committed synthetic data in
`public-data/sample/`). A real file that violates the contract is **not** masked by sample data: the layer is disabled and
the validator message is logged. A "SAMPLE" badge in the footer says when sample data is in use.

### Wind sampling and reduced motion
Readout and "current conditions" use `windLayer.sample()` when present, else a local bilinear sampler on the decoded PNG
(`field.ts`). Direction is meteorological (where the wind blows FROM). With `prefers-reduced-motion` the particles are
replaced by a static, viewport-sampled arrow field (also selectable in the layer panel), the storm pulse stops and
camera moves are instant.

## Keyboard
`Cmd/Ctrl+K` palette, `Space` play/pause, arrows step frames, `W S H E Q F` toggle layers, `L` locate, `?` help, `Esc` close.

## Performance (measured on `pnpm --filter web build`, headless Chrome, ANGLE/Metal)
| item | value |
|---|---|
| initial JS (`check-js-budget.mjs`) | **~89 kB** gzip (budget 150 kB; was 66.8 kB before round 2) |
| lazy chunks | maplibre ~298 kB gz, map/weather code ~55 kB, decode worker, isobar worker, scalar-layer in the map chunk |
| first wind frame, no service worker | ~3.1 s from navigation start in this harness, but the HTML itself took ~2.95 s to arrive (a headless-Chrome first-request artefact; curl gets it in 2 ms). About 0.18 s after the HTML. |
| first wind frame, service worker warm | ~0.15 s from navigation start (frames from the SW cache) |
| meteogram, 4 series x 25 frames of real GFS (100 PNGs, 50 MB decoded) | complete 0.47 s after the click; the next point 1.3 ms |
| panning, 240 frames | 60 fps, p95 16.8 ms, in each of: wind only; 13 253 real storms from 7 basins; 82 216 real flashes (MapLibre circle layer, data-driven age style); all three together |

The pan test is vsync-locked, so it shows "no dropped frames", not the GPU headroom; it ran on this Mac's GPU only.
Lightning approach: a MapLibre circle layer whose colour/opacity are an expression of `now - t`, re-evaluated every 5 s (not per frame), met
the target at 82k points, so no custom WebGL points layer was built. The live version (CONTRACTS 6.2) will need one.

## Not verified / known limitations
- Verified visually in headless Chrome only (layout, wind, pressure + isobars, temperature, rain, model switch, meteogram, lightning,
  history with 7 basins, share-link restore, mobile 390 px). No real-GPU frame budget, no Safari/Firefox, no touch device.
- In `vite dev` the isobar worker fails (the package references `./isobarsWorker.js` for a `.ts` file); the production build bundles it and works.
- The service worker was exercised in Chrome only (cache contents inspected; a deploy bumps `version` and drops old caches).
- The live lightning experience (6.2: polling `recent.json`, animation, sound) is NOT built; only the queue (`lightning/player.ts`, tested).
- Supabase auth/DB calls were never exercised against a real project; Nominatim is a user-initiated request to the public OSM instance.
- The command palette searches historical storms only in basins that are loaded.
- Sample data (`public-data/sample/**`, `pnpm --filter web sample`) uses a 2 degree grid, 4 frames per field, synthetic tracks and flashes.

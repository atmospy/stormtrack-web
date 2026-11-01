# StormTrack Web: `apps/web`

SvelteKit (static SPA, `@sveltejs/adapter-static`) + MapLibre GL JS globe + `@stormtrack/wind-layer` + Supabase.
Opens on a full-screen interactive globe with live wind particles, active cyclones and hazards.

## Run

```bash
pnpm install                       # from the repo root
cp apps/web/.env.example apps/web/.env   # optional
pnpm --filter web dev              # http://localhost:5173
pnpm --filter web check            # svelte-check, strict TS
pnpm --filter web test             # vitest (43 tests)
pnpm --filter web build            # static site in apps/web/build (deploy to Cloudflare Pages)
pnpm --filter web sample           # regenerate public-data/sample/** (synthetic, committed)
```

Env (`PUBLIC_*`, read via `import.meta.env`): `PUBLIC_DATA_BASE` (default `/data`), `PUBLIC_SUPABASE_URL`,
`PUBLIC_SUPABASE_ANON_KEY`. Without the Supabase pair the app runs in a labelled **demo mode**.

## Architecture

```
src/lib/config.ts        all constants (data base, login-gate thresholds, playback)
src/lib/data/            contracts.ts (runtime validators), load.ts (fetch + sample fallback), boot.ts, active.ts, cities.ts
src/lib/wind/            adapter.ts (lazy import of @stormtrack/wind-layer), field.ts (CPU sampler), frames.ts (LRU frame cache), runtime.svelte.ts
src/lib/map/             style.ts (custom dark OpenFreeMap style), storms.ts, hazards.ts, arrows.ts
src/lib/auth/            gate.ts (pure login-gate logic), client.ts (lazy supabase-js), auth.svelte.ts (store + stubs)
src/lib/stores/          app.svelte.ts (single app state, runes), gate / toast stores
src/lib/components/      MapView, TopBar, LayerPanel, TimeBar, Readout, Conditions, StormPanel, CommandPalette (lazy), AuthModal (lazy), ...
```

Note: SvelteKit 3 removed `$lib`; the app uses `#lib/*` (package.json `imports` + tsconfig `paths`).

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

## Performance (measured on `pnpm --filter web build`)
| item | gzip |
|---|---|
| initial JS (13 files in `index.html`) | **~66.8 kB** (181 kB raw) |
| initial CSS | ~6.5 kB |
| maplibre-gl chunk (lazy) | ~294 kB (+10 kB CSS) |
| supabase-js chunk (lazy) | ~55 kB |
| wind-layer chunk (lazy) | ~10 kB |
| command palette, auth modal, help (lazy) | ~1-3 kB each |

Budget is 150 kB excluding maplibre: met with large headroom. Frame rate was not measured (see below).

## Not verified / known limitations
- Verified visually only in headless Chrome with software WebGL (SwiftShader): layout, wind particles (real GFS from
  workstream B), storms, cone, panel, palette, auth modal, gate card, playback stepping, mobile (390 px) and reduced motion
  were all inspected. **60 fps and first-paint timing on real GPUs were not measured.**
- Supabase auth/DB calls were never exercised (no project); only the demo-mode path ran.
- Google OAuth, magic link, saved places, follows: written against CONTRACTS §4, untested against a real backend.
- Nominatim place search is a user-initiated request (Enter in the palette) to the public OSM instance; fine for light use,
  replace with a self-hosted geocoder before real traffic.
- In dev, a missing real file produces a browser-console 404 line before the sample fallback (unavoidable for a fetch).
- No Playwright smoke test was added (browser tooling here is not part of the repo); Vitest covers logic.
- Forecast features in `active.geojson` have no `id` in CONTRACTS §2; the app attaches them to the nearest position.
- Historical-storm sparklines are not possible (history props carry only the peak wind).

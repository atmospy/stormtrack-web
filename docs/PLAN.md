# StormTrack Web — plan

A fast, highly interactive weather-and-storms app. Think windy.com, but built around
**storm tracks and analysis**: open it and you immediately see live wind and any active
cyclones / fires / other hot events; click a storm and you can inspect its track, forecast
cone, history and climatology, compare IMD vs IBTrACS, and run analyses. Later: models,
forecasts, balloon soundings and every other open dataset we can use.

The analysis engine already exists: the [`stormtrack`](https://github.com/atmospy/stormtrack)
Python library (IMD + IBTrACS best tracks, real-time NHC/JTWC, verification).

## Principles

1. **Static first.** Everything the homepage needs is a pre-computed static file on a CDN
   (wind textures, storm GeoJSON, hazard GeoJSON). No server round-trip on first paint.
   A Python API exists only for things that must be computed per request.
2. **GPU does the work.** Wind particles, colour ramps and point sampling run in WebGL shaders
   on a data texture. The main thread only handles UI.
3. **Budgets** (enforced in CI where measurable):
   - initial JS ≤ 150 kB gzip *excluding* the map library (which loads in parallel);
   - first meaningful paint (basemap + wind) ≤ 2 s on a normal broadband connection;
   - 60 fps wind animation on a mid-range laptop; degrade (fewer particles) rather than stutter;
   - each wind frame ≤ 400 kB; frames are lazy-loaded and cached.
4. **Honest data.** Every layer shows source, run time and licence. Never present agency
   wind speeds from different averaging periods as comparable without saying so
   (IMD 3-min vs NHC/JTWC 1-min — see `stormtrack` docs).
5. **Free to run.** Everything runs on free tiers until there is traffic (Cloudflare Pages +
   R2, Supabase free, GitHub Actions cron). No paid API keys required for the MVP.

## Stack (decided; change only with a written reason)

| concern | choice | why |
|---|---|---|
| App | **SvelteKit + TypeScript** (static adapter → Cloudflare Pages) | smallest runtime, fastest hydration |
| Map | **MapLibre GL JS** (globe projection) | open source, WebGL, custom layers |
| Wind | custom **WebGL particle layer** in `packages/wind-layer` | the signature feature; must be ours |
| Overlays | MapLibre native layers (GeoJSON) for storms/hazards | simple, fast enough at our feature counts |
| Data products | Python **ingest** jobs → static files → **Cloudflare R2** | zero egress cost, CDN-cached |
| Analysis API | **FastAPI** wrapping `stormtrack` (Render/Fly), later | needs Python; not on the critical path |
| Auth + DB | **Supabase** (Auth + Postgres + RLS) | user's choice |
| CI/cron | **GitHub Actions** (build, test, scheduled ingest) | free, already used |
| Basemap | OpenFreeMap vector tiles for dev; self-hosted Protomaps PMTiles on R2 later | no API key |

## Data sources (all open; verify licence and limits in each agent's spike)

| layer | source | access |
|---|---|---|
| Wind (10 m, then pressure levels) | NOAA **GFS** 0.25° | public S3 `noaa-gfs-bdp-pds`; `.idx` files allow byte-range download of only the U/V records |
| Wind (alt. model) | **ECMWF open data** IFS 0.25° (CC-BY-4.0) | public S3 `ecmwf-forecasts` |
| Active cyclones | NHC ATCF, JTWC b-decks via UCAR mirror | through the `stormtrack.realtime` module |
| Historical tracks | IMD best track + IBTrACS | `stormtrack.load()` / `load_ibtracs()` |
| Fires / volcanoes / floods / etc. | NASA **EONET** (no key); NASA **FIRMS** hotspots (free MAP_KEY — optional) | REST |
| Earthquakes | USGS GeoJSON feeds | REST |
| Later | ECMWF/GFS more variables, radiosondes (balloons), satellite, radar, waves, air quality | per-source spike |

NHC and JTWC are the only agencies with machine-readable real-time storm forecasts. IMD, JMA,
BoM and Météo-France publish none, so the app cannot show their forecasts as data.

## Milestones

**M0 — foundations (parallel build, this round)**
Monorepo, data contracts, and five independent workstreams (below) that meet at the contracts.
Done = each workstream passes its own tests and `docs/CONTRACTS.md` is honoured.

**M1 — integrated first release**
Wire everything: homepage shows live wind + active storms + hazards; click a storm for a
panel; login gate (after ~3 min of use) with Supabase; deploy a preview to Cloudflare Pages;
scheduled ingest to R2. Performance budgets measured.

**M2 — analysis & more layers**
Storm analysis views (climatology, ACE, rapid intensification, IMD vs IBTrACS compare),
FastAPI for on-demand analysis, temperature / pressure / precip layers, forecast time slider,
model switch GFS ↔ ECMWF, saved places/views, storm follows + alerts.

**M3 — data breadth**
Balloon soundings, satellite/radar, waves, air quality, multi-model forecast comparison,
embeddable widgets, public API.

## Workstreams for M0 (each owns a directory; do not edit others')

| id | name | owns | deliverable |
|---|---|---|---|
| A | Web app shell | `apps/web/` | SvelteKit app: full-screen globe/map, futuristic dark UI, layer panel, time scrubber, storm click panel, command palette, login-gate flow, wired to the contracts using sample data |
| B | Wind ingest | `services/ingest/wind/` | Python job: GFS → wind textures + `latest.json`, per CONTRACTS §1 |
| C | Wind layer | `packages/wind-layer/` | TypeScript MapLibre custom WebGL layer: particles + colour ramp + point sampling, per CONTRACTS §1 |
| D | Storms & hazards data | `services/ingest/storms/`, `services/ingest/hazards/`, `services/api/` | Jobs producing storm + hazard files per CONTRACTS §2–3 using `stormtrack`; a minimal FastAPI skeleton |
| E | Auth, DB & infra | `supabase/`, `.github/workflows/`, `docs/DEPLOY.md`, `infra/` | Supabase migrations + RLS + local config; CI; scheduled-ingest workflow; Cloudflare/R2/Render configs and a deploy guide |

## Round 2 (M2a): decisions

Chosen for "next-gen, fast, interactive", in priority order. Everything stays on the existing
architecture (static files on a CDN, WebGL2 on the GPU, MapLibre globe); we do **not** adopt WebGPU
(MapLibre has no stable WebGPU path, and WebGL2 already runs 1M particles at 60 fps here).

1. **Models and levels as first-class controls.** NOAA GFS and ECMWF **IFS** and **AIFS** (ECMWF's
   AI forecast model, open data) switchable in one click; winds at 10 m, 850, 700, 500, 300, 250 hPa.
   The same time slider drives everything.
2. **More scalar layers:** mean sea-level pressure (with **isobars** drawn client-side), 2 m
   temperature, precipitation. Rendered as colour-mapped GPU textures; isobars via marching squares in a
   Web Worker.
3. **Click anywhere → instant meteogram** (wind/pressure/temp/precip vs time for that point),
   computed from the frames already in memory: zero API calls, zero latency. A genuine differentiator.
4. **Lightning layer.** Shipped now with the only fully open real-time source, NOAA **GOES GLM** (20 s
   cadence). It covers the **Americas, Atlantic and eastern Pacific only**; the UI shows the coverage footprint
   and says plainly that there is no open feed for South Asia.
   *What the others do:* Windy switched (6 Oct 2023) from Blitzortung to **LINET, a commercial global network run
   by Nowcast.de**, under an undisclosed partnership (global with minor ocean gaps, seconds-to-tens-of-seconds
   delay). Nowcast sells the data via an "offer" form; no public price or API. Blitzortung's own terms restrict
   commercial and warning use and state there is no external API, so we do not use or scrape it. EUMETSAT's MTG
   Lightning Imager is open after a free Data Store key but covers Europe/Africa/Middle East/Atlantic.
   *Global lightning therefore needs a licence decision (owner):* (a) ask Nowcast for an offer, or (b) ask
   Blitzortung's operators for a data-access agreement (their stated conditions: freely accessible application,
   data served from our own server, CC-BY-SA, credit, not for warning systems), or (c) wait. The ingest keeps a
   source-agnostic `sources/` extension point, so adding a licensed feed is configuration plus credentials.
5. **Speed plumbing:** prefetch the next frames, decode on a worker (`createImageBitmap` off-thread),
   cache frames with a service worker, and keep all view state in the URL so any view is a shareable link.

Later (M3): ECMWF-based multi-model comparison, balloon soundings, satellite/radar, storm alerts,
an AI "storm brief" summary.

## Needs from the owner (agents cannot do these)
- Create the **Supabase** project (agents write migrations and a local dev setup).
- Create **Cloudflare** account resources (Pages project, R2 bucket + API token) and a
  **GitHub** repo for this code (suggested: `atmospy/stormtrack-web`).
- Optional: NASA **FIRMS MAP_KEY** (free) for fire hotspots.
- **Lightning outside the Americas:** decide whether to request a licence from Nowcast (LINET) and/or Blitzortung (see Round 2, item 4).
- Choose a product name/domain (working name: *StormTrack*).
- The `stormtrack` library's PyPI release (pending trusted-publisher setup) — until then the
  Python services install it from a local checkout / git URL.

## Risks
- **Licensing/limits**: Open-Meteo is free for non-commercial use only; we avoid it in
  production and derive "current conditions" from our own GFS data.
- **Client-side login gate is bypassable.** It is an engagement prompt, not security; anything
  that must be protected (saved data, heavy analysis) is enforced server-side with RLS / auth.
- **Wind texture precision** (8-bit) is visually fine but not for science; the point-readout
  must say "model, ~0.5° grid".
- **GFS availability**: a run lands ~3.5–5 h after its nominal time; ingest must pick the
  latest *complete* run and fall back to the previous one.

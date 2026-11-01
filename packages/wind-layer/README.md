# @stormtrack/wind-layer

Animated wind particles as a **MapLibre GL JS custom layer** (globe and mercator), driven by the
wind PNG data textures defined in [`docs/CONTRACTS.md` §1](../../docs/CONTRACTS.md). TypeScript, ESM, no runtime
dependencies (`maplibre-gl >= 5` is a peer dependency; developed against 6.16).

## Usage

```ts
import { WindLayer } from '@stormtrack/wind-layer';

const layer = new WindLayer({ id: 'wind' });
map.addLayer(layer);                       // before or after style load; add below labels with the 2nd arg

const j = await (await fetch(`${base}/wind/latest.json`)).json();
// IMPORTANT: decode without colour management or the data bytes are altered
const bmp = await createImageBitmap(await (await fetch(`${base}/${j.frames[0].png}`)).blob(),
  { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
layer.setFrame(j.image, bmp);              // optionally: setFrame(meta, bmpA, bmpB, 0.35) to blend two forecast hours
layer.sample(lon, lat);                    // { u, v, speed, deg } m/s, deg = direction wind comes FROM (270 = westerly)
```

## API

```ts
new WindLayer({ id?, particleCount = 32768, speedFactor = 1, fadeOpacity = 0.94, lineWidth = 1.4,
  colorRamp = DEFAULT_COLOR_RAMP, dropRate = 0.003, dropRateBump = 0.01, opacity = 1,
  reducedMotion: boolean | 'auto' = 'auto', adaptive = true, targetFps = 60, minParticleCount = 4096,
  forcePackedState = false })
layer.setFrame(meta, image, nextImage?, mix?)     // image: ImageBitmap | HTMLImageElement | HTMLCanvasElement | OffscreenCanvas | ImageData
layer.setMix(mix)                                 // cheap re-blend of the two frames (e.g. while a time slider is dragged)
layer.setOptions(partial)   layer.setVisible(bool)   layer.destroy()
layer.sample(lon, lat) -> { u, v, speed, deg } | null
layer.getStats() -> { fps, frameMs, particles, maxParticles, state, projection, reducedMotion, ready }
decodeWindImage(image, meta) -> { u: Float32Array, v: Float32Array, width, height }   // m/s
sampleField / sampleWind / toSample / isGlobalLon     // the CPU sampler used by layer.sample(), pure functions
DEFAULT_COLOR_RAMP, buildColorRamp(stops), parseCssColor(css)
types: WindImageMeta, WindLayerOptions, WindLayerStats, WindSample, WindImageSource, ColorRamp
```

`speedFactor` 1 means a 1 m/s wind moves particles ~5 CSS px per second at any zoom (steps scale with
`1/2^zoom`, so on-screen speed is zoom-independent while direction/relative speed stay physical).
Defaults to `reducedMotion: 'auto'`: with the OS "reduce motion" setting on, a static streamline field is drawn
(no animation, no continuous repaint). Force with `setOptions({ reducedMotion: true })`.

Consuming it in the workspace: `exports` points at `src/index.ts` so apps (Vite/SvelteKit) use it with no build step.
`pnpm build` emits `dist/` (`main/module/types`), and `publishConfig.exports` switches to `dist/` on publish.

## How it works

Particle state (web-mercator position in [0,1]^2) lives in a texture, ping-ponged by a fragment-shader **update
pass**: sample the wind texture (hardware bilinear, `REPEAT` on longitude so the +-180 seam is seamless, clamp at
the poles), advect, and randomly respawn (base rate + speed bump, plus all particles that left the viewport are
respawned *inside the viewport*, so the whole budget is always on screen). The **draw pass** is instanced: one
screen-space quad per particle from its previous to its current projected position, projected with MapLibre's own
`projectTile()` GLSL (taken from `shaderData` / `defaultProjectionData`), so globe, mercator and the transition
between them work with the same shader. Quads are drawn into a screen-sized RGBA8 **trail texture** that is faded
each frame (`c*fade - 1.5/255`, the subtraction kills 8-bit ghosting) and then composited as the layer. Colour is a
256x1 ramp texture indexed by speed. No vertex buffers, no per-frame JS allocations in the render path.

* State storage: `RGBA32F` (needs `EXT_color_buffer_float`) else an RGBA8-packed 16+16 bit fallback (about 1/65000 of the
  world per axis, so very slow particles stall at high zoom; still looks fine). Check `getStats().state`.
* Two-frame blending: both textures are sampled in-shader and mixed in the decoded domain.
* Camera moves: the trail texture is cleared whenever the projection matrix changes (no smearing) and respawn is boosted so
  newly revealed areas fill quickly. While you pan, particles therefore show as short segments, not long trails.
* Adaptive quality: an EMA of the frame interval; >30 % over budget for 20 frames drops the drawn/simulated count by 20 %,
  <10 % over for 3 s raises it 10 %, between `minParticleCount` and `particleCount`. It cannot tell a slow GPU from a
  30 Hz display; set `targetFps: 30` or `adaptive: false` there. The interval includes MapLibre's own work.
* Colour ramp (`DEFAULT_COLOR_RAMP`): cyan -> green -> yellow -> orange -> red-pink -> magenta -> pale pink at 0/3/7/11/16/22/29/40 m/s.
  All stops are bright (luminance well above the dark basemap) so calm air stays visible; hue ordering gives a
  cool-to-hot reading; the pale end makes jets/cyclone cores glow. Hue alone is not colour-blind safe (green vs orange),
  luminance rises toward yellow to help.

## Browser support

WebGL2 only (MapLibre 5+ requires it; a WebGL1 path was deliberately not written). Chrome/Edge/Firefox/Safari 15+.

## Verification status

Done (see below for numbers): 23 Vitest tests in Node (decode round trip, bilinear incl. seam/poles/regional grids,
direction convention, ramp, shader-source structure); the demo run in headless Chrome (ANGLE/Metal, Apple M1 Pro) with
screenshots on **globe and mercator**, synthetic and real GFS data, zoom 1.5 - 5.5, frame blending, the RGBA8-packed
fallback, reduced-motion, lon 180 seam.
Only verifiable visually / on hardware: shader behaviour (no GPU in the unit tests), globe correctness, perf on weak GPUs.

## Known limitations (candid)

* **Globe**: rendered correctly, but particles are simulated for the whole visible lon/lat bounding box, so on the globe at low zoom
  roughly half of them sit on the far side and are clipped (effective density about half). Back-hemisphere clipping is MapLibre's
  clipping plane. Near the poles the globe stretches mercator-derived trails; mercator itself is clipped at +-85.05 deg.
* Mercator world copies: drawn (up to 4), but particles are only simulated once for the wrapped world.
* Context loss: MapLibre drops custom layers when the context is lost; re-add the layer after `webglcontextrestored`
  (`map.addLayer(layer)`). Resources are rebuilt lazily. Hard-tested only lightly (headless `WEBGL_lose_context`, MapLibre itself logged errors).
* No 3D terrain support (`renderToTerrainTile` not implemented). Layer ordering: the canvas is composited at the layer's
  position in the style, so labels above it stay readable.
* `sample()` uses the decoded frame, not particle positions; if the ImageBitmap is already closed when `setFrame` is
  called, rendering works but `sample()` returns null.
* Edges are antialiased analytically across the line width only; line ends are not rounded.
* Lines use the speed at the particle's *current* position for colour (fine at this resolution).

## Performance (measured)

Headless Chrome, M1 Pro, 1200x800 @1x, mercator, real GFS frame, adaptive off, vsync-capped 60 Hz: 65k, 262k and 1.05M particles
all held 60 fps (GPU was not saturated); starting adaptive at 2M settled at about 1.4M for 57.8 fps. This says the layer is
cheap on a strong GPU, not what a mid-range integrated GPU will do; the adaptive mechanism exists for that.

## Licensing / inspiration

Own implementation. The technique (state in a texture updated by a fragment shader, trail ping-pong) was popularised by Mapbox's
[`webgl-wind`](https://github.com/mapbox/webgl-wind) (ISC) and extended by [`windgl`](https://github.com/astrosat/windgl) / windy.com-style
renderers; no code was copied. Instanced screen-space quads, mercator-space state, viewport-bounded respawn, two-frame blending
and the `projectTile` integration are this package's own. MIT.

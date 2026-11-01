# @stormtrack/scalar-layer

Colour-mapped scalar fields (pressure, temperature, precipitation, ...) as a **MapLibre GL JS custom layer**
(globe and mercator), plus **isobar generation** (marching squares, labels, H/L centres) that runs in a Web Worker.
Driven by the 16-bit scalar PNGs of [`docs/CONTRACTS.md` §1b](../../docs/CONTRACTS.md). TypeScript, ESM, no runtime
dependencies (`maplibre-gl >= 5` peer; developed against 6.16). About 11 kB gzip minified (excluding maplibre).

## Usage

```ts
import { ScalarLayer, SCALAR_RAMPS, createIsobarWorker } from '@stormtrack/scalar-layer';

const layer = new ScalarLayer({ id: 'field', ramp: SCALAR_RAMPS.temperature, opacity: 0.75 });
map.addLayer(layer, beforeId);

const meta = { grid: latest.grid, range: field.range, transform: field.transform }; // from <model>/latest.json
// IMPORTANT: decode without colour management or the data bytes are altered
const bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
layer.setFrame(meta, bmp, nextBmp, 0.35);   // two frames blended in the shader; setMix() re-blends cheaply
layer.sample(lon, lat);                     // physical units (hPa, degC, mm), bilinear, wrap-safe, or null

const iso = createIsobarWorker();
const { lines, labels, centres } = await iso.isobars(bmp, meta, { interval: 4, base: 1000 });
map.getSource('iso').setData(lines);        // line layer; `labels` -> symbol layer (text-field ["get","text"],
map.getSource('isoLabels').setData(labels); //   text-rotate ["get","angle"]); `centres` -> "H"/"L" symbols
```

## API

```ts
new ScalarLayer({ id?, ramp = SCALAR_RAMPS.viridis, opacity = 0.8, valueRange?, visible = true })
layer.setFrame(meta, image, nextImage?, mix?)   // image: ImageBitmap | HTMLImageElement | HTMLCanvasElement | OffscreenCanvas | ImageData
layer.setMix(m)  layer.setRamp(ramp)  layer.setOptions({ opacity, valueRange, ramp })  layer.setVisible(b)  layer.destroy()
layer.sample(lon, lat): number | null           // blended by the current mix
layer.getDecoded('a' | 'b'): DecodedScalar | null   // lazily decoded physical-unit field (meteograms, contours)

decodeScalarImage(image, meta): { values: Float32Array, width, height, lon_left, lon_right, lat_top, lat_bottom }
sampleScalar(decoded, lon, lat): number | null  // the CPU twin of the shader
buildIsobars(decoded, { interval = 4, base = 1000, smooth = 0 }): FeatureCollection   // LineString | MultiLineString, { value, major }
buildIsobarSet(decoded, opts): { lines, labels, centres }
   // labels: Point { value, text, angle, major }; centres: Point { type: 'H'|'L', value }
   // more options: majorEvery (5), labelSpacing (14 deg), minLabelLength (5), extremaRadius (10 deg), extremaMinDelta, decimals
createIsobarWorker(): { isobars(image, meta, opts & { transfer? }): Promise<IsobarResult>, terminate() }
SCALAR_RAMPS: { temperature, pressure, precipitation, viridis }    buildRampLUT / rampColorAt / parseCssColor
encodeScalar(values, meta) / valueToCode / codeToValue                // build test PNG data
```

`ScalarFrameMeta = { grid: { width, height, lon_left, lon_right, lat_top, lat_bottom }, range: [min, max], transform?: 'sqrt', rangeIn?: 'physical' | 'encoded' }`.

**Contract ambiguity (sqrt).** §1b says "encode `sqrt(x)` instead of `x`". `range` can be read as the range of `x`
(default here, `rangeIn: 'physical'`: code = `(sqrt(x)-sqrt(min))/(sqrt(max)-sqrt(min))`) or of `sqrt(x)` (`rangeIn: 'encoded'`;
for precip `[0,100]` that would mean 10 000 mm). The producer and this package must agree; pass `rangeIn: 'encoded'`
if the producer is literal.

## How it renders

* A static mesh (1 deg, stored as web-mercator world coordinates, ~65 k vertices) goes through MapLibre's own
  `projectTile()` (the `shaderData` prelude, like `wind-layer`), so globe, mercator and the globe-to-mercator
  transition all work. In flat projections five world copies (-2..2) are drawn; in globe one. Back-face clipping
  comes from MapLibre's clipping plane.
* The fragment shader recovers lon/lat from the interpolated mercator position and samples the data itself.
* **16-bit bilinear without artefacts.** The PNG is an RGBA8 texture with `NEAREST` filtering. Hardware bilinear would
  blend the hi and lo byte channels separately, which is wrong when the lo byte wraps (code 0x01FF -> 0x0200 would
  interpolate through ~0x0100 garbage, visible as banding/contouring). Instead four `texelFetch` taps rebuild
  `R*256+G` per texel, convert to the physical value (squaring for `sqrt`), and interpolate **physical values**
  manually. `sampleScalar` is the identical CPU algorithm (texel centres on grid nodes, longitude wraps on global grids,
  rows clamp at the poles), so `layer.sample()` equals what is drawn. Tests cover byte-boundary codes.
* Two frames blend in the shader (`mix`); the textures are reused when a frame slides from `next` to `current`.
* The ramp is a 512 x 1 LUT (Oklab interpolation, straight alpha) spread over `valueRange ?? range`. For `sqrt`
  fields the LUT is indexed in sqrt space so 0.1-1 mm gets as many texels as 40-100 mm. Output is premultiplied.
* Context loss: `webglcontextlost` is cancelled and drawing pauses; on restore programs, buffers and textures are
  rebuilt lazily from the retained images. DPR: nothing is sized in pixels (geometry is the mesh), so devicePixelRatio
  does not matter. Rendering errors disable the layer (logged) instead of throwing into MapLibre's loop.

## Colour ramps

Stops are absolute physical values (hPa, degC, mm) and are laid over the frame's range, so a colour means the same
value whichever range a model publishes (values outside the stops clamp to the end colours). Interpolation is in Oklab
so intermediate colours do not turn muddy. All ramps are meant for a dark basemap at ~0.7-0.9 opacity.

* **temperature** (-40..+50 degC). Diverging blue <-> orange around the freezing point, where the ramp is near white,
  which makes "above/below freezing" the first thing the eye sees. Blue/orange avoids the red-green axis, so it holds
  up for protan/deutan viewers; lightness peaks at 0 degC and falls toward both extremes, so magnitude is also readable
  in greyscale. Caveat: the violet end (-40) is dim against a near-black ocean.
* **pressure** (940..1060 hPa). Deliberately low-contrast slate (blue-grey lows, neutral 1013, warm-grey highs): the
  isobars and H/L markers carry the information, the fill only gives a hint of the pattern.
* **precipitation** (mm, sqrt-encoded). Sequential, fully transparent below 0.1 mm, then translucent blue -> cyan ->
  yellow -> orange -> pink -> magenta -> pale lilac. Lightness rises with amount through yellow; beyond that hue
  carries order (lightness dips at red/magenta), so the very top of the scale is the least CVD-robust part.
* **viridis**. Perceptually uniform and CVD-safe generic ramp (stops are fractions of the range). Its dark end blends
  into a dark basemap; prefer another ramp for fields with large calm areas.

These choices are judgements, not user-tested; the CVD claims follow from hue/lightness reasoning and were not checked
with a simulator.

## Isobars

Marching squares in one pass over the grid (each cell visits only the levels between its min and max), saddle cells
resolved by the cell mean, segments chained by edge identity. Edge ids wrap modulo the grid width on global grids, so
rings crossing the +-180 seam close without special cases; output longitudes are in [-180, 180] and any feature that
crosses the antimeridian is split into a `MultiLineString` with vertices exactly on +-180 (a ring that starts mid-way is
re-joined before splitting). Labels are placed every `labelSpacing` degrees of arc along each line (phase-shifted per
level so they do not line up) with an upright `text-rotate` angle; none within 5 deg of the poles. H/L centres are
extrema over a +-`extremaRadius` window that differ from the window's opposite extreme by at least `extremaMinDelta`.
The pure functions work in a worker; `createIsobarWorker()` uses `new Worker(new URL('./isobarsWorker.js', import.meta.url), { type: 'module' })`
(Vite/webpack friendly; the image is structured-cloned unless `transfer: true`).

## Limitations

* Latitudes above 89.99 deg are not drawn; the mercator world ends at +-85.05 deg (the same limit as wind-layer).
* The mesh is 1 deg: on the globe at zoom > ~6 chord error is below a pixel (MapLibre blends to flat well before that);
  the colours themselves are computed per fragment and are exact.
* Needs WebGL2 (MapLibre 6 requires it as well); no WebGL1 or canvas fallback. If the shader fails to compile the layer
  disables itself and the map keeps working.
* `sample()` decodes through a 2D canvas on first use; the image source must stay open (do not `close()` the bitmap).
* Isobars are computed on the data grid (0.25-0.5 deg); with `smooth: 0` lines are polylines of grid-crossing points.

## Commands

`pnpm build` (tsc to `dist/`), `pnpm check`, `pnpm test`, `pnpm demo` (Vite on http://127.0.0.1:5200;
`?field=mslp|t2m|precip&projection=mercator|globe&iso=0&opacity=..`; `?data=/data` reads
`public-data/weather/index.json` -> model `latest.json` -> scalar frames, and falls back to the procedural fields).

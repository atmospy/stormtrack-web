/**
 * Thin adapter over the workspace package `@stormtrack/scalar-layer` (workstream C2). Imported lazily so the
 * GL code and the contour code stay out of the initial bundle.
 *   new ScalarLayer({ id, ramp, opacity }); layer.setFrame(meta, image, nextImage?, mix?) ...
 *   createIsobarWorker().isobars(bitmap, meta, opts) -> { lines, labels, centres }
 */
import type { IsobarResult, ScalarFrameMeta, ScalarLayer, ScalarRamp } from '@stormtrack/scalar-layer';
import type { ScalarField, WeatherGrid } from '#lib/data/weather';
import type { Variable } from '#lib/weather/select';

export type ScalarLayerLike = ScalarLayer;
export type { IsobarResult, ScalarFrameMeta, ScalarRamp };

const load = () => import('@stormtrack/scalar-layer');

export async function createScalarLayer(opts: { id: string; ramp: ScalarRamp; opacity?: number }): Promise<ScalarLayer> {
  const m = await load();
  return new m.ScalarLayer(opts);
}

/** Temperature range worth colouring at each pressure level (degC); the surface ramp spans -30..45. */
const TEMP_SPAN: Record<string, [number, number]> = {
  '850': [-30, 35],
  '700': [-35, 20],
  '500': [-50, -5],
  '300': [-65, -25],
  '250': [-70, -30]
};
const SURFACE_SPAN: [number, number] = [-30, 45];
const retargeted = new Map<string, ScalarRamp>();

/** Colour ramp for a variable; temperature on a pressure level reuses the surface colours over that level's range. */
export async function rampFor(v: Variable, level = '10m'): Promise<ScalarRamp | null> {
  const m = await load();
  if (v === 'temperature') {
    const span = TEMP_SPAN[level];
    if (!span) return m.SCALAR_RAMPS.temperature;
    let r = retargeted.get(level);
    if (!r) {
      const [a, b] = SURFACE_SPAN;
      const k = (span[1] - span[0]) / (b - a);
      r = { ...m.SCALAR_RAMPS.temperature, stops: m.SCALAR_RAMPS.temperature.stops.map(([x, c]) => [span[0] + (x - a) * k, c] as [number, string]) };
      retargeted.set(level, r);
    }
    return r;
  }
  return v === 'pressure' ? m.SCALAR_RAMPS.pressure : v === 'precipitation' ? m.SCALAR_RAMPS.precipitation : null;
}

const metas = new WeakMap<ScalarField, ScalarFrameMeta>();
/** Stable meta object per field (the layer reuses textures when it sees the same meta + image). */
export function scalarMeta(grid: WeatherGrid, f: ScalarField): ScalarFrameMeta {
  let m = metas.get(f);
  if (!m || m.grid !== grid) {
    m = { grid, range: f.range, ...(f.transform ? { transform: f.transform } : {}) };
    metas.set(f, m);
  }
  return m;
}

type IsoWorker = Awaited<ReturnType<typeof load>> extends { createIsobarWorker: () => infer W } ? W : never;
let worker: IsoWorker | null = null;

/** Isobars every 4 hPa (base 1000), contoured in the package's worker. The bitmap is cloned, so the GPU copy stays valid. */
export async function computeIsobars(image: ImageBitmap, meta: ScalarFrameMeta): Promise<IsobarResult> {
  const m = await load();
  worker ??= m.createIsobarWorker();
  const copy = await createImageBitmap(image, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  return worker.isobars(copy, meta, { interval: 4, base: 1000, upsample: 2, smooth: 1 });
}

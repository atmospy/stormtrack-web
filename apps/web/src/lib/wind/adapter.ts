/**
 * Thin adapter over the workspace package `@stormtrack/wind-layer` (workstream C).
 * Real API (packages/wind-layer/src/layer.ts):
 *   new WindLayer({ id, particleCount, colorRamp, reducedMotion, ... })   // MapLibre CustomLayerInterface
 *   layer.setFrame(imageMeta, imageBitmap, nextBitmap?, mix?)             // mix = temporal blend 0..1
 *   layer.setMix(mix) / layer.setOptions(opts) / layer.sample(lon, lat) / layer.getStats()
 * It is imported lazily so it stays out of the initial bundle.
 */
import type { WindLayer, WindLayerOptions, ColorRamp } from '@stormtrack/wind-layer';

export type WindLayerLike = WindLayer;
export type { WindLayerOptions };

export async function createWindLayer(opts: WindLayerOptions): Promise<WindLayer> {
  const mod = await import('@stormtrack/wind-layer');
  return new mod.WindLayer(opts);
}

/** Plain white particles, used over a colour field where the speed colours would be lost in it. */
export const WHITE_RAMP: ColorRamp = [
  [0, '#ffffff'],
  [40, '#ffffff']
];

/** Speed colour ramp used by the arrow field and the legend (matches the particle layer's look). */
export const WIND_RAMP: ColorRamp = [
  [0, '#4cc9ff'],
  [3, '#2ee6c4'],
  [7, '#6fe85c'],
  [11, '#e8e43a'],
  [16, '#ffa02e'],
  [22, '#ff4f6a'],
  [29, '#f23fd0'],
  [40, '#ffc4f3']
];

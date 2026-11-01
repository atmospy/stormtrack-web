export { WindLayer } from './layer.js';
export { decodeWindImage, sampleField, sampleWind, toSample, isGlobalLon, readPixels } from './decode.js';
export type { WindField } from './decode.js';
export { DEFAULT_COLOR_RAMP, buildColorRamp, parseCssColor } from './ramp.js';
export type { RampTexture } from './ramp.js';
export type {
  WindImageMeta,
  WindImageSource,
  WindLayerOptions,
  WindLayerStats,
  WindSample,
  ColorRamp,
  ImageDataLike,
} from './types.js';

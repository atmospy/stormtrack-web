export { ScalarLayer, physicalRange } from './layer.js';
export { decodeScalarImage, sampleScalar, encodeScalar, valueToCode, codeToValue, isGlobalLon, readPixels } from './decode.js';
export { buildIsobars, buildIsobarSet, splitAtAntimeridian, upsampleScalar } from './contour.js';
export { SCALAR_RAMPS, buildRampLUT, rampColorAt, parseCssColor } from './ramp.js';
export { createIsobarWorker } from './worker.js';
export type { IsobarWorker } from './worker.js';
export type {
  ScalarFrameMeta,
  ScalarGrid,
  ScalarImageSource,
  ScalarLayerOptions,
  ScalarRamp,
  DecodedScalar,
  IsobarOptions,
  IsobarResult,
  ImageDataLike,
} from './types.js';

/// <reference lib="webworker" />
import { buildIsobarSet } from './contour.js';
import { decodeScalarImage } from './decode.js';
import type { IsobarOptions, IsobarResult, ScalarFrameMeta, ScalarImageSource } from './types.js';

export interface IsobarRequest {
  id: number;
  image: ScalarImageSource;
  meta: ScalarFrameMeta;
  opts?: IsobarOptions;
}
export type IsobarResponse = { id: number; result: IsobarResult } | { id: number; error: string };

/** Worker entry: decode + contour. Imported as `new Worker(new URL('./isobarsWorker.js', import.meta.url))`. */
const scope = self as unknown as DedicatedWorkerGlobalScope;
scope.onmessage = (e: MessageEvent<IsobarRequest>) => {
  const { id, image, meta, opts } = e.data;
  try {
    const result = buildIsobarSet(decodeScalarImage(image, meta), opts);
    scope.postMessage({ id, result } satisfies IsobarResponse);
  } catch (err) {
    scope.postMessage({ id, error: err instanceof Error ? err.message : String(err) } satisfies IsobarResponse);
  }
};

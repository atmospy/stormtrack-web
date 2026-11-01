/** Grid geometry shared by every field of a model (CONTRACTS §1b `grid`). Texel centres sit on grid nodes. */
export interface ScalarGrid {
  width: number;
  height: number;
  lon_left: number;
  lon_right: number;
  lat_top: number;
  lat_bottom: number;
}

/** Metadata of one scalar PNG: the `grid` + `range` (+ `transform`) of a field in `weather/<model>/latest.json`. */
export interface ScalarFrameMeta {
  grid: ScalarGrid;
  /** physical min/max the 16-bit code spans (e.g. hPa, degC, mm). */
  range: [min: number, max: number];
  /**
   * `"sqrt"`: the PNG stores sqrt(x) normalised between sqrt(min) and sqrt(max) (physical range), so low values
   * keep resolution. Decoding squares it.
   */
  transform?: 'sqrt';
  /**
   * Only for `transform: "sqrt"`. Default `"physical"`: `range` is in x units. `"encoded"`: `range` bounds sqrt(x)
   * (the literal reading of CONTRACTS §1b), i.e. x = (min + t*(max-min))^2.
   */
  rangeIn?: 'physical' | 'encoded';
}

/** Anything `texImage2D` accepts that we can also read pixels from. */
export type ScalarImageSource = ImageBitmap | HTMLImageElement | HTMLCanvasElement | OffscreenCanvas | ImageData;

/** Minimal ImageData look-alike (usable in Node tests). */
export interface ImageDataLike {
  data: ArrayLike<number>;
  width: number;
  height: number;
}

/** A decoded field in physical units (transform already undone). Row 0 = lat_top. */
export interface DecodedScalar extends ScalarGrid {
  values: Float32Array;
}

/**
 * Colour ramp over ABSOLUTE physical values (`[value, css colour]`, ascending). The layer rasterises it over the
 * frame's range (or `valueRange`); values outside the stops clamp to the first/last colour. With `normalized: true`
 * the stop positions are fractions 0..1 of the range instead (generic ramps).
 */
export interface ScalarRamp {
  name?: string;
  unit?: string;
  stops: Array<[value: number, css: string]>;
  normalized?: boolean;
}

export interface ScalarLayerOptions {
  id?: string;
  ramp?: ScalarRamp;
  /** 0..1, default 0.8 */
  opacity?: number;
  /** override the range the ramp is spread over (default: the frame's `range`) */
  valueRange?: [number, number];
  visible?: boolean;
}

export interface IsobarOptions {
  /** contour spacing in field units (default 4) */
  interval?: number;
  /** a contour always exists at base + k*interval (default 1000) */
  base?: number;
  /** Chaikin corner-cutting iterations applied to every line (default 0; the 0.25 deg grid is already smooth) */
  smooth?: number;
  /** a line gets a "major" flag every `majorEvery` intervals (default 5) */
  majorEvery?: number;
  /** label spacing along a line, in degrees of arc (default 14) */
  labelSpacing?: number;
  /** lines shorter than this (degrees of arc) are not labelled (default 5) */
  minLabelLength?: number;
  /** half-size of the H/L search window in degrees (default 10) */
  extremaRadius?: number;
  /** minimum drop/rise relative to the window's opposite extreme to count as H/L (default = interval) */
  extremaMinDelta?: number;
  /** decimals in label text (default 0) */
  decimals?: number;
}

export interface IsobarResult {
  lines: FeatureCollection<LineString | MultiLineString, { value: number; major: boolean }>;
  /** Points with `{ value, text, angle, major }`; `angle` is a MapLibre `text-rotate` (deg clockwise from east, upright). */
  labels: FeatureCollection<Point, { value: number; text: string; angle: number; major: boolean }>;
  /** Pressure-centre style extrema: `{ type: 'H' | 'L', value }` */
  centres: FeatureCollection<Point, { type: 'H' | 'L'; value: number }>;
}

// Minimal GeoJSON shapes (kept local so the package needs no @types/geojson); structurally compatible with maplibre's.
export interface Feature<G, P> {
  type: 'Feature';
  properties: P;
  geometry: G;
}
export interface FeatureCollection<G, P> {
  type: 'FeatureCollection';
  features: Array<Feature<G, P>>;
}
export interface LineString {
  type: 'LineString';
  coordinates: Array<[number, number]>;
}
export interface MultiLineString {
  type: 'MultiLineString';
  coordinates: Array<Array<[number, number]>>;
}
export interface Point {
  type: 'Point';
  coordinates: [number, number];
}

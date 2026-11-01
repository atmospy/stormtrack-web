/** Metadata of one wind PNG, exactly the `image` object of `public-data/wind/latest.json` (CONTRACTS §1). */
export interface WindImageMeta {
  width: number;
  height: number;
  lon_left: number;
  lon_right: number;
  lat_top: number;
  lat_bottom: number;
  u: { min: number; max: number };
  v: { min: number; max: number };
  speed_max: number;
}

/** Anything `texImage2D` accepts that we can also read pixels from. */
export type WindImageSource = ImageBitmap | HTMLImageElement | HTMLCanvasElement | OffscreenCanvas | ImageData;

/** Minimal ImageData look-alike (usable in Node tests). */
export interface ImageDataLike {
  data: ArrayLike<number>;
  width: number;
  height: number;
}

export type ColorRamp = Array<[speedMs: number, cssColor: string]>;

export interface WindSample {
  /** eastward component, m/s */
  u: number;
  /** northward component, m/s */
  v: number;
  /** m/s */
  speed: number;
  /** meteorological direction: where the wind comes FROM, degrees clockwise from north (0 = N, 270 = from the west) */
  deg: number;
}

export interface WindLayerOptions {
  /** custom-layer id (default "wind") */
  id?: string;
  /** maximum number of particles (default 32768). Adaptive quality may draw fewer. */
  particleCount?: number;
  /** visual speed multiplier, 1 = default (default 1) */
  speedFactor?: number;
  /** per-frame (at 60 fps) multiplier of the trail texture, 0..1: higher = longer trails (default 0.94) */
  fadeOpacity?: number;
  /** particle line width in CSS pixels (default 1.4) */
  lineWidth?: number;
  /** [speed m/s, css colour] stops, ascending (default {@link DEFAULT_COLOR_RAMP}) */
  colorRamp?: ColorRamp;
  /** base probability per frame that a particle respawns (default 0.003) */
  dropRate?: number;
  /** extra respawn probability proportional to speed (default 0.01) */
  dropRateBump?: number;
  /** whole-layer opacity 0..1 (default 1) */
  opacity?: number;
  /** `true`: static streamline field, `false`: animate, `"auto"`: follow `prefers-reduced-motion` (default "auto") */
  reducedMotion?: boolean | 'auto';
  /** adapt the drawn particle count to hold `targetFps` (default true) */
  adaptive?: boolean;
  /** target frame rate for adaptive quality (default 60) */
  targetFps?: number;
  /** lowest particle count adaptive quality will go to (default 4096) */
  minParticleCount?: number;
  /** skip float state textures and use the RGBA8-packed fallback (testing / old GPUs) */
  forcePackedState?: boolean;
}

export interface WindLayerStats {
  /** smoothed frames per second of the map render loop */
  fps: number;
  /** smoothed frame interval, ms */
  frameMs: number;
  /** particles currently simulated and drawn */
  particles: number;
  /** allocated particle budget */
  maxParticles: number;
  /** particle-state storage in use */
  state: 'float32' | 'rgba8-packed' | 'none';
  /** projection variant MapLibre handed to the layer, e.g. "globe" / "mercator" */
  projection: string;
  /** true while rendering the static reduced-motion field */
  reducedMotion: boolean;
  /** true after a frame has been supplied and GL resources exist */
  ready: boolean;
}

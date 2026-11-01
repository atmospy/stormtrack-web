import type { CustomLayerInterface, CustomRenderMethodInput, Map as MaplibreMap } from 'maplibre-gl';
import { decodeWindImage, isGlobalLon, sampleField, toSample, type WindField } from './decode.js';
import { createProgram, makeTexture, type Program } from './gl.js';
import { buildColorRamp, DEFAULT_COLOR_RAMP } from './ramp.js';
import {
  COMPOSITE_FRAGMENT,
  DRAW_FRAGMENT,
  FADE_FRAGMENT,
  FULLSCREEN_VS,
  drawVertexSource,
  updateFragmentSource,
} from './shaders.js';
import type { WindImageMeta, WindImageSource, WindLayerOptions, WindLayerStats, WindSample } from './types.js';

/** Visual speed: CSS pixels per second travelled per 1 m/s of wind at speedFactor = 1. */
const PX_PER_MS = 5;
/** Length (seconds of travel) of the streamlines drawn in reduced-motion mode. */
const STATIC_SECONDS = 0.3;
const STATIC_MAX_PARTICLES = 9000;

const U_UNIT = { wind_a: 0, wind_b: 1, state: 2, prev: 3, ramp: 4, trail: 5 } as const;

type ProjData = CustomRenderMethodInput['defaultProjectionData'];

interface Slot {
  src: WindImageSource;
  meta: WindImageMeta;
  field: WindField | null;
  tex: WebGLTexture | null;
}

interface Resolved extends Required<Omit<WindLayerOptions, 'id'>> {}

const DEFAULTS: Resolved = {
  particleCount: 32768,
  speedFactor: 1,
  fadeOpacity: 0.94,
  lineWidth: 1.4,
  colorRamp: DEFAULT_COLOR_RAMP,
  dropRate: 0.003,
  dropRateBump: 0.01,
  opacity: 1,
  reducedMotion: 'auto',
  adaptive: true,
  targetFps: 60,
  minParticleCount: 4096,
  forcePackedState: false,
};

function posData(n: number, pack8: boolean): Float32Array | Uint8Array {
  if (!pack8) {
    const a = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      a[i * 4] = Math.random();
      a[i * 4 + 1] = Math.random();
      a[i * 4 + 3] = 1;
    }
    return a;
  }
  const a = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 2; k++) {
      const s = Math.random() * 255;
      a[i * 4 + 2 + k] = Math.floor(s);
      a[i * 4 + k] = Math.floor((s - Math.floor(s)) * 255);
    }
  }
  return a;
}

/**
 * GPU wind-particle layer for MapLibre GL JS (custom layer; globe and mercator).
 * See README for the algorithm. All GL work happens inside MapLibre's `prerender`/`render` callbacks
 * so MapLibre's cached GL state is never corrupted between frames.
 */
export class WindLayer implements CustomLayerInterface {
  readonly id: string;
  readonly type = 'custom' as const;
  readonly renderingMode = '2d' as const;

  private o: Resolved;
  private map: MaplibreMap | null = null;
  private gl: WebGL2RenderingContext | null = null;
  private visible = true;
  private destroyed = false;

  // frames
  private slotA: Slot | null = null;
  private slotB: Slot | null = null;
  private mixV = 0;
  private trash: WebGLTexture[] = [];
  private frameDirty = true;

  // GL resources
  private pUpdate: Program | null = null;
  private pFade: Program | null = null;
  private pComposite: Program | null = null;
  private pDraw = new Map<string, Program>();
  private vao: WebGLVertexArrayObject | null = null;
  private stateTex: [WebGLTexture, WebGLTexture] | null = null;
  private stateFbo: [WebGLFramebuffer, WebGLFramebuffer] | null = null;
  private cur = 0;
  private stateW = 0;
  private stateH = 0;
  private stateKind: 'float32' | 'rgba8-packed' | 'none' = 'none';
  private allocatedCount = 0;
  private trailTex: [WebGLTexture, WebGLTexture] | null = null;
  private trailFbo: [WebGLFramebuffer, WebGLFramebuffer] | null = null;
  private trailIdx = 0;
  private trailW = 0;
  private trailH = 0;
  private rampTex: WebGLTexture | null = null;
  private rampMax = 40;
  private rampDirty = true;
  private pendingResize = false;

  // runtime state
  private active = 0;
  private lastT = 0;
  private emaMs = 16.7;
  private goodFrames = 0;
  private badFrames = 0;
  private fresh = true;
  private camPrev = new Float32Array(16);
  private camTmp = new Float32Array(16);
  private camTrans = -1;
  private view = new Float64Array([0, 0, 1, 1]);
  private viewDirty = true;
  private staticDirty = true;
  private wasStatic = false;
  private projName = 'unknown';
  private mqReduce: MediaQueryList | null = null;
  private mat4Tmp = new Float32Array(16);
  private lost = false;
  private stats: WindLayerStats = {
    fps: 0,
    frameMs: 0,
    particles: 0,
    maxParticles: 0,
    state: 'none',
    projection: 'unknown',
    reducedMotion: false,
    ready: false,
  };

  constructor(options: WindLayerOptions = {}) {
    this.id = options.id ?? 'wind';
    this.o = { ...DEFAULTS };
    this.applyOptions(options);
  }

  // ------------------------------------------------------------------ public API

  /**
   * Provide the current frame (and optionally the next one for temporal blending).
   * `image` must hold the raw PNG bytes: create bitmaps with
   * `createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' })`.
   * Passing the same image object again is free (textures are cached per image).
   */
  setFrame(meta: WindImageMeta, image: WindImageSource, nextImage?: WindImageSource | null, mix = 0): void {
    const reuse = (src: WindImageSource): Slot => {
      for (const s of [this.slotA, this.slotB]) if (s && s.src === src && s.meta === meta) return s;
      let field: WindField | null = null;
      try {
        field = decodeWindImage(src, meta);
      } catch {
        field = null; // e.g. bitmap already closed - rendering still works, sample() returns null
      }
      return { src, meta, field, tex: null };
    };
    const a = reuse(image);
    const b = nextImage ? reuse(nextImage) : null;
    for (const old of [this.slotA, this.slotB]) {
      if (old && old !== a && old !== b && old.tex) this.trash.push(old.tex);
      if (old && old !== a && old !== b) old.tex = null;
    }
    this.slotA = a;
    this.slotB = b;
    this.mixV = b ? Math.min(Math.max(mix, 0), 1) : 0;
    this.frameDirty = true;
    this.staticDirty = true;
    this.map?.triggerRepaint();
  }

  /** Cheap blend update between the two frames given to {@link setFrame}. */
  setMix(mix: number): void {
    this.mixV = this.slotB ? Math.min(Math.max(mix, 0), 1) : 0;
    this.staticDirty = true;
  }

  setOptions(opts: WindLayerOptions): void {
    const before = { ...this.o };
    this.applyOptions(opts);
    if (opts.colorRamp && opts.colorRamp !== before.colorRamp) this.rampDirty = true;
    if (opts.particleCount !== undefined && opts.particleCount !== before.particleCount) this.pendingResize = true;
    if (opts.forcePackedState !== undefined && opts.forcePackedState !== before.forcePackedState) this.pendingResize = true;
    this.staticDirty = true;
    this.map?.triggerRepaint();
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.fresh = true;
    this.staticDirty = true;
    this.map?.triggerRepaint();
  }

  /** CPU bilinear sample of the current frame (blended with the next one by the current mix), in m/s. */
  sample(lon: number, lat: number): WindSample | null {
    const a = this.slotA;
    if (!a?.field) return null;
    const sa = sampleField(a.field, a.meta, lon, lat);
    if (!sa) return null;
    const b = this.slotB;
    if (b?.field && this.mixV > 0 && b.field.width === a.field.width && b.field.height === a.field.height) {
      const sb = sampleField(b.field, b.meta, lon, lat);
      if (sb) return toSample(sa.u + (sb.u - sa.u) * this.mixV, sa.v + (sb.v - sa.v) * this.mixV);
    }
    return toSample(sa.u, sa.v);
  }

  getStats(): WindLayerStats {
    return this.stats;
  }

  get options(): Readonly<Resolved> {
    return this.o;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.map && this.map.getLayer(this.id)) this.map.removeLayer(this.id);
    else this.releaseGL();
  }

  // ------------------------------------------------------------------ CustomLayerInterface

  onAdd(map: MaplibreMap, gl: WebGL2RenderingContext): void {
    this.map = map;
    this.lost = false;
    this.gl = gl;
    this.destroyed = false;
    map.on('move', this.markView);
    map.on('resize', this.markView);
    map.on('moveend', this.markView);
    const canvas = map.getCanvas();
    canvas.addEventListener('webglcontextlost', this.onLost);
    canvas.addEventListener('webglcontextrestored', this.onRestored);
    if (typeof matchMedia === 'function') {
      this.mqReduce = matchMedia('(prefers-reduced-motion: reduce)');
      this.mqReduce.addEventListener?.('change', this.onMq);
    }
    this.viewDirty = true;
    this.fresh = true;
  }

  onRemove(map: MaplibreMap): void {
    map.off('move', this.markView);
    map.off('resize', this.markView);
    map.off('moveend', this.markView);
    const canvas = map.getCanvas();
    canvas.removeEventListener('webglcontextlost', this.onLost);
    canvas.removeEventListener('webglcontextrestored', this.onRestored);
    this.mqReduce?.removeEventListener?.('change', this.onMq);
    this.releaseGL();
    this.map = null;
    this.gl = null;
  }

  prerender(gl: WebGL2RenderingContext, args: CustomRenderMethodInput): void {
    if (!this.visible || this.lost || !this.slotA) return;
    try {
      this.step(gl, args);
    } catch (e) {
      this.visible = false;
      console.error('[wind-layer] disabled after GL error: ' + (e instanceof Error ? e.message : String(e)));
    }
  }

  render(gl: WebGL2RenderingContext, _args: CustomRenderMethodInput): void {
    if (!this.visible || this.lost || !this.trailTex || !this.pComposite || !this.slotA) return;
    const p = this.pComposite;
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.STENCIL_TEST);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.SCISSOR_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(p.prog);
    gl.activeTexture(gl.TEXTURE0 + U_UNIT.trail);
    gl.bindTexture(gl.TEXTURE_2D, this.trailTex[this.trailIdx]!);
    gl.uniform1i(p.u.u_trail!, U_UNIT.trail);
    gl.uniform1f(p.u.u_opacity!, this.o.opacity);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
    const animating = !this.isStatic();
    if (animating) this.map?.triggerRepaint();
  }

  // ------------------------------------------------------------------ internals

  private applyOptions(opts: WindLayerOptions): void {
    for (const k of Object.keys(opts) as Array<keyof WindLayerOptions>) {
      if (k === 'id' || opts[k] === undefined) continue;
      (this.o as unknown as Record<string, unknown>)[k] = opts[k];
    }
    this.o.fadeOpacity = Math.min(Math.max(this.o.fadeOpacity, 0), 0.999);
    this.o.particleCount = Math.max(256, Math.floor(this.o.particleCount));
  }

  private isStatic(): boolean {
    const r = this.o.reducedMotion;
    return r === true || (r === 'auto' && !!this.mqReduce?.matches);
  }

  private markView = (): void => {
    this.viewDirty = true;
  };
  private onMq = (): void => {
    this.staticDirty = true;
    this.fresh = true;
    this.map?.triggerRepaint();
  };
  private onLost = (e: Event): void => {
    e.preventDefault();
    this.lost = true;
  };
  private onRestored = (): void => {
    // every GL object died with the context; drop references and rebuild lazily
    this.pDraw.clear();
    this.pUpdate = this.pFade = this.pComposite = null;
    this.vao = null;
    this.stateTex = this.trailTex = null;
    this.stateFbo = this.trailFbo = null;
    this.rampTex = null;
    this.trash.length = 0;
    if (this.slotA) this.slotA.tex = null;
    if (this.slotB) this.slotB.tex = null;
    this.rampDirty = true;
    this.pendingResize = true;
    this.fresh = true;
    this.lost = false;
    this.map?.triggerRepaint();
  };

  private releaseGL(): void {
    const gl = this.gl;
    if (gl && !this.lost) {
      for (const p of [this.pUpdate, this.pFade, this.pComposite, ...this.pDraw.values()]) if (p) gl.deleteProgram(p.prog);
      for (const t of [...(this.stateTex ?? []), ...(this.trailTex ?? []), this.rampTex, this.slotA?.tex, this.slotB?.tex, ...this.trash]) {
        if (t) gl.deleteTexture(t);
      }
      for (const f of [...(this.stateFbo ?? []), ...(this.trailFbo ?? [])]) gl.deleteFramebuffer(f);
      if (this.vao) gl.deleteVertexArray(this.vao);
    }
    this.pDraw.clear();
    this.pUpdate = this.pFade = this.pComposite = null;
    this.stateTex = this.trailTex = null;
    this.stateFbo = this.trailFbo = null;
    this.rampTex = null;
    this.vao = null;
    this.trash.length = 0;
    this.stateKind = 'none';
    this.stats.ready = false;
  }

  private computeView(): void {
    this.viewDirty = false;
    const map = this.map!;
    const b = map.getBounds();
    const west = b.getWest();
    const east = b.getEast();
    const north = Math.min(Math.max(b.getNorth(), -85.0511), 85.0511);
    const south = Math.min(Math.max(b.getSouth(), -85.0511), 85.0511);
    const merY = (lat: number) => 0.5 - Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / (2 * Math.PI);
    let x0 = (west + 180) / 360;
    let x1 = (east + 180) / 360;
    let y0 = merY(north);
    let y1 = merY(south);
    if (!Number.isFinite(x0 + x1 + y0 + y1) || x1 - x0 <= 0) {
      x0 = 0;
      x1 = 1;
      y0 = 0;
      y1 = 1;
    }
    const px = (x1 - x0) * 0.08;
    const py = (y1 - y0) * 0.08;
    this.view[0] = x0 - px;
    this.view[1] = Math.max(0, y0 - py);
    this.view[2] = x1 + px;
    this.view[3] = Math.min(1, y1 + py);
    this.staticDirty = true;
  }

  // ---- allocation

  private ensureResources(gl: WebGL2RenderingContext): void {
    if (!this.vao) this.vao = gl.createVertexArray();
    if (!this.pFade) {
      this.pFade = createProgram(gl, FULLSCREEN_VS, FADE_FRAGMENT);
      this.pComposite = createProgram(gl, FULLSCREEN_VS, COMPOSITE_FRAGMENT);
    }
    if (!this.stateTex || this.pendingResize || this.allocatedCount !== this.o.particleCount) this.allocState(gl);
    if (!this.rampTex || this.rampDirty) this.allocRamp(gl);
    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;
    if (!this.trailTex || w !== this.trailW || h !== this.trailH) this.allocTrail(gl, w, h);
  }

  private allocState(gl: WebGL2RenderingContext): void {
    this.pendingResize = false;
    if (this.stateTex) {
      for (const t of this.stateTex) gl.deleteTexture(t);
      for (const f of this.stateFbo!) gl.deleteFramebuffer(f);
    }
    const n = this.o.particleCount;
    this.allocatedCount = n;
    this.stateW = Math.ceil(Math.sqrt(n));
    this.stateH = Math.ceil(n / this.stateW);
    const cap = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE) as number, 8192);
    if (this.stateW > cap) throw new Error('wind-layer: particleCount exceeds texture limits');

    const tryKind = (pack8: boolean): boolean => {
      const texs: WebGLTexture[] = [];
      const fbos: WebGLFramebuffer[] = [];
      const data = posData(this.stateW * this.stateH, pack8);
      for (let i = 0; i < 2; i++) {
        const t = makeTexture(gl, { filter: gl.NEAREST });
        if (pack8) {
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, this.stateW, this.stateH, 0, gl.RGBA, gl.UNSIGNED_BYTE, data as Uint8Array);
        } else {
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, this.stateW, this.stateH, 0, gl.RGBA, gl.FLOAT, data as Float32Array);
        }
        const f = gl.createFramebuffer()!;
        gl.bindFramebuffer(gl.FRAMEBUFFER, f);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
        texs.push(t);
        fbos.push(f);
      }
      const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE && gl.getError() === gl.NO_ERROR;
      if (!ok) {
        texs.forEach((t) => gl.deleteTexture(t));
        fbos.forEach((f) => gl.deleteFramebuffer(f));
        return false;
      }
      this.stateTex = [texs[0]!, texs[1]!];
      this.stateFbo = [fbos[0]!, fbos[1]!];
      this.stateKind = pack8 ? 'rgba8-packed' : 'float32';
      return true;
    };

    let done = false;
    if (!this.o.forcePackedState && gl.getExtension('EXT_color_buffer_float')) {
      gl.getError();
      done = tryKind(false);
    }
    if (!done) done = tryKind(true);
    if (!done) throw new Error('wind-layer: cannot create a renderable particle-state texture');

    // programs depend on the storage kind
    const old = [this.pUpdate, ...this.pDraw.values()];
    for (const p of old) if (p) gl.deleteProgram(p.prog);
    this.pDraw.clear();
    this.pUpdate = createProgram(gl, FULLSCREEN_VS, updateFragmentSource(this.stateKind === 'rgba8-packed'));
    this.cur = 0;
    this.active = Math.min(this.active || n, n);
    if (this.active < this.o.minParticleCount) this.active = Math.min(n, this.o.minParticleCount);
    if (!this.o.adaptive || this.active > n) this.active = n;
    this.fresh = true;
  }

  private allocTrail(gl: WebGL2RenderingContext, w: number, h: number): void {
    if (this.trailTex) {
      for (const t of this.trailTex) gl.deleteTexture(t);
      for (const f of this.trailFbo!) gl.deleteFramebuffer(f);
    }
    const texs: WebGLTexture[] = [];
    const fbos: WebGLFramebuffer[] = [];
    for (let i = 0; i < 2; i++) {
      const t = makeTexture(gl, { filter: gl.NEAREST });
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      const f = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, f);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      texs.push(t);
      fbos.push(f);
    }
    this.trailTex = [texs[0]!, texs[1]!];
    this.trailFbo = [fbos[0]!, fbos[1]!];
    this.trailW = w;
    this.trailH = h;
    this.trailIdx = 0;
    this.fresh = true;
    this.staticDirty = true;
  }

  private allocRamp(gl: WebGL2RenderingContext): void {
    this.rampDirty = false;
    const r = buildColorRamp(this.o.colorRamp, 256);
    this.rampMax = r.maxSpeed;
    if (!this.rampTex) this.rampTex = makeTexture(gl, { filter: gl.LINEAR });
    gl.activeTexture(gl.TEXTURE0 + U_UNIT.ramp);
    gl.bindTexture(gl.TEXTURE_2D, this.rampTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, r.size, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, r.data);
  }

  private uploadSlot(gl: WebGL2RenderingContext, s: Slot): void {
    if (s.tex) return;
    const global = isGlobalLon(s.meta);
    s.tex = makeTexture(gl, { filter: gl.LINEAR, wrapS: global ? gl.REPEAT : gl.CLAMP_TO_EDGE, wrapT: gl.CLAMP_TO_EDGE });
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    const src = s.src as unknown as { data?: Uint8ClampedArray; width: number; height: number };
    if (src.data && typeof ImageData === 'undefined') {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, src.width, src.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(src.data.buffer));
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, s.src as TexImageSource);
    }
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.BROWSER_DEFAULT_WEBGL);
  }

  // ---- per-frame

  private drawProgram(gl: WebGL2RenderingContext, args: CustomRenderMethodInput): Program {
    const key = args.shaderData.variantName + (this.stateKind === 'rgba8-packed' ? ':p8' : ':f32');
    let p = this.pDraw.get(key);
    if (!p) {
      p = createProgram(
        gl,
        drawVertexSource(args.shaderData.vertexShaderPrelude, args.shaderData.define, this.stateKind === 'rgba8-packed'),
        DRAW_FRAGMENT,
      );
      this.pDraw.set(key, p);
    }
    this.projName = args.shaderData.variantName;
    return p;
  }

  private setMat(gl: WebGL2RenderingContext, loc: WebGLUniformLocation | null | undefined, m: ArrayLike<number>): void {
    if (!loc) return;
    this.mat4Tmp.set(m as ArrayLike<number>);
    gl.uniformMatrix4fv(loc, false, this.mat4Tmp);
  }

  private bindWind(gl: WebGL2RenderingContext, p: Program, meta: WindImageMeta): void {
    const a = this.slotA!;
    const b = this.slotB ?? a;
    gl.activeTexture(gl.TEXTURE0 + U_UNIT.wind_a);
    gl.bindTexture(gl.TEXTURE_2D, a.tex!);
    gl.activeTexture(gl.TEXTURE0 + U_UNIT.wind_b);
    gl.bindTexture(gl.TEXTURE_2D, b.tex!);
    const u = p.u;
    gl.uniform1i(u.u_wind_a!, U_UNIT.wind_a);
    gl.uniform1i(u.u_wind_b!, U_UNIT.wind_b);
    gl.uniform1f(u.u_mix!, this.slotB ? this.mixV : 0);
    gl.uniform2f(u.u_urange!, meta.u.min, meta.u.max);
    gl.uniform2f(u.u_vrange!, meta.v.min, meta.v.max);
    const dx = (meta.lon_right - meta.lon_left) / (meta.width - 1);
    const dy = (meta.lat_top - meta.lat_bottom) / (meta.height - 1);
    gl.uniform4f(u.u_grid!, meta.lon_left, meta.lat_top, dx, dy);
    gl.uniform2f(u.u_size!, meta.width, meta.height);
    gl.uniform1f(u.u_global!, isGlobalLon(meta) ? 1 : 0);
  }

  private step(gl: WebGL2RenderingContext, args: CustomRenderMethodInput): void {
    const map = this.map!;
    const meta = this.slotA!.meta;
    this.ensureResources(gl);
    // upload frames / free old ones
    for (const t of this.trash) gl.deleteTexture(t);
    this.trash.length = 0;
    this.uploadSlot(gl, this.slotA!);
    if (this.slotB) this.uploadSlot(gl, this.slotB);
    if (this.viewDirty) this.computeView();

    const now = performance.now();
    const rawDt = this.lastT ? now - this.lastT : 16.7;
    this.lastT = now;
    const static_ = this.isStatic();

    // ---- camera change detection
    const pd = args.defaultProjectionData;
    this.camTmp.set(pd.mainMatrix as ArrayLike<number>);
    let moved = this.camTrans !== pd.projectionTransition;
    if (!moved) for (let i = 0; i < 16; i++) if (this.camTmp[i] !== this.camPrev[i]) { moved = true; break; }
    this.camPrev.set(this.camTmp);
    this.camTrans = pd.projectionTransition;

    // ---- adaptive quality (ignore stalls such as hidden tabs)
    if (rawDt < 250) {
      this.emaMs += (rawDt - this.emaMs) * 0.08;
      if (this.o.adaptive && !static_) this.adapt();
    }
    const dt = Math.min(rawDt, 50) / 1000;
    this.updateStats(static_);

    if (static_) {
      this.renderStatic(gl, args, meta, moved);
      this.wasStatic = true;
      return;
    }
    if (this.wasStatic) {
      this.wasStatic = false;
      this.fresh = true;
    }

    // ---- simulation
    const zoom = map.getZoom();
    const worldPx = 512 * Math.pow(2, zoom);
    const stepMs = (dt * PX_PER_MS * this.o.speedFactor) / worldPx;
    const rows = Math.min(this.stateH, Math.ceil(this.active / this.stateW));

    gl.bindVertexArray(this.vao);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.STENCIL_TEST);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.SCISSOR_TEST);

    const up = this.pUpdate!;
    const next = 1 - this.cur;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.stateFbo![next]!);
    gl.viewport(0, 0, this.stateW, rows);
    gl.useProgram(up.prog);
    this.bindWind(gl, up, meta);
    gl.activeTexture(gl.TEXTURE0 + U_UNIT.state);
    gl.bindTexture(gl.TEXTURE_2D, this.stateTex![this.cur]!);
    gl.uniform1i(up.u.u_state!, U_UNIT.state);
    gl.uniform1f(up.u.u_step!, stepMs);
    gl.uniform1f(up.u.u_seed!, Math.random());
    const boost = moved || this.fresh ? 0.06 : 0;
    gl.uniform1f(up.u.u_drop!, this.o.dropRate + boost);
    gl.uniform1f(up.u.u_drop_bump!, this.o.dropRateBump);
    gl.uniform1f(up.u.u_speed_max!, meta.speed_max);
    gl.uniform4f(up.u.u_view!, this.view[0]!, this.view[1]!, this.view[2]!, this.view[3]!);
    gl.uniform1f(up.u.u_reseed!, this.fresh ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    // the previous state stays in `cur`, the new one in `next` -> draw reads both
    const prevIdx = this.cur;
    this.cur = next;

    // ---- trails: fade (or clear when the camera moved), then draw
    const dstIdx = 1 - this.trailIdx;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.trailFbo![dstIdx]!);
    gl.viewport(0, 0, this.trailW, this.trailH);
    if (moved || this.fresh) {
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    } else {
      const fp = this.pFade!;
      gl.useProgram(fp.prog);
      gl.activeTexture(gl.TEXTURE0 + U_UNIT.trail);
      gl.bindTexture(gl.TEXTURE_2D, this.trailTex![this.trailIdx]!);
      gl.uniform1i(fp.u.u_trail!, U_UNIT.trail);
      gl.uniform1f(fp.u.u_fade!, Math.pow(this.o.fadeOpacity, Math.min(dt, 0.1) * 60));
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    this.drawParticles(gl, args, meta, this.active, stepMs, prevIdx, false);
    this.trailIdx = dstIdx;
    this.fresh = false;
    this.frameDirty = false;
    gl.bindVertexArray(null);
  }

  private drawParticles(
    gl: WebGL2RenderingContext,
    args: CustomRenderMethodInput,
    meta: WindImageMeta,
    count: number,
    stepMs: number,
    prevIdx: number,
    isStatic: boolean,
  ): void {
    const p = this.drawProgram(gl, args);
    gl.useProgram(p.prog);
    this.bindWind(gl, p, meta);
    gl.activeTexture(gl.TEXTURE0 + U_UNIT.state);
    gl.bindTexture(gl.TEXTURE_2D, this.stateTex![this.cur]!);
    gl.activeTexture(gl.TEXTURE0 + U_UNIT.prev);
    gl.bindTexture(gl.TEXTURE_2D, this.stateTex![prevIdx]!);
    gl.activeTexture(gl.TEXTURE0 + U_UNIT.ramp);
    gl.bindTexture(gl.TEXTURE_2D, this.rampTex!);
    const u = p.u;
    gl.uniform1i(u.u_state!, U_UNIT.state);
    gl.uniform1i(u.u_prev!, U_UNIT.prev);
    gl.uniform1i(u.u_ramp!, U_UNIT.ramp);
    gl.uniform1i(u.u_state_w!, this.stateW);
    gl.uniform2f(u.u_viewport!, this.trailW, this.trailH);
    const dpr = this.map!.getPixelRatio();
    gl.uniform1f(u.u_half_width!, (this.o.lineWidth * dpr) / 2);
    gl.uniform1f(u.u_max_delta!, stepMs * meta.speed_max);
    gl.uniform1f(u.u_ramp_max!, this.rampMax);
    gl.uniform1f(u.u_static!, isStatic ? 1 : 0);
    gl.uniform1f(u.u_static_len!, isStatic ? stepMs * STATIC_SECONDS : 0);
    // projection uniforms
    const pd: ProjData = args.defaultProjectionData;
    this.setMat(gl, u.u_projection_matrix, pd.mainMatrix);
    this.setMat(gl, u.u_projection_fallback_matrix, pd.fallbackMatrix);
    if (u.u_projection_tile_mercator_coords) gl.uniform4fv(u.u_projection_tile_mercator_coords, pd.tileMercatorCoords);
    if (u.u_projection_clipping_plane) gl.uniform4fv(u.u_projection_clipping_plane, pd.clippingPlane);
    if (u.u_projection_transition) gl.uniform1f(u.u_projection_transition, pd.projectionTransition);

    // world copies: only matter in flat (mercator) rendering
    const isGlobe = args.shaderData.define.indexOf('GLOBE') >= 0;
    let k0 = 0;
    let k1 = 0;
    if (!(isGlobe && pd.projectionTransition > 0.999)) {
      k0 = Math.floor(this.view[0]!);
      k1 = Math.min(Math.floor(this.view[2]!), k0 + 3);
    }
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    for (let k = k0; k <= k1; k++) {
      gl.uniform1f(u.u_x_off!, k);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
    }
    gl.disable(gl.BLEND);
  }

  private renderStatic(gl: WebGL2RenderingContext, args: CustomRenderMethodInput, meta: WindImageMeta, moved: boolean): void {
    const redo = moved || this.staticDirty || this.fresh || this.frameDirty;
    if (!redo) return;
    this.staticDirty = false;
    this.fresh = false;
    this.frameDirty = false;
    const count = Math.min(this.allocatedCount, STATIC_MAX_PARTICLES);
    const rows = Math.ceil(count / this.stateW);
    const worldPx = 512 * Math.pow(2, this.map!.getZoom());
    const stepMs = (PX_PER_MS * this.o.speedFactor) / worldPx; // mercator units per (m/s) per second
    gl.bindVertexArray(this.vao);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.STENCIL_TEST);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.SCISSOR_TEST);
    const up = this.pUpdate!;
    const next = 1 - this.cur;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.stateFbo![next]!);
    gl.viewport(0, 0, this.stateW, rows);
    gl.useProgram(up.prog);
    this.bindWind(gl, up, meta);
    gl.activeTexture(gl.TEXTURE0 + U_UNIT.state);
    gl.bindTexture(gl.TEXTURE_2D, this.stateTex![this.cur]!);
    gl.uniform1i(up.u.u_state!, U_UNIT.state);
    gl.uniform1f(up.u.u_step!, 0);
    gl.uniform1f(up.u.u_seed!, 0.37);
    gl.uniform1f(up.u.u_drop!, 0);
    gl.uniform1f(up.u.u_drop_bump!, 0);
    gl.uniform1f(up.u.u_speed_max!, meta.speed_max);
    gl.uniform4f(up.u.u_view!, this.view[0]!, this.view[1]!, this.view[2]!, this.view[3]!);
    gl.uniform1f(up.u.u_reseed!, 1);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const prevIdx = this.cur;
    this.cur = next;

    const dst = 1 - this.trailIdx;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.trailFbo![dst]!);
    gl.viewport(0, 0, this.trailW, this.trailH);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.drawParticles(gl, args, meta, count, stepMs, prevIdx, true);
    this.trailIdx = dst;
    this.stats.particles = count;
    gl.bindVertexArray(null);
  }

  private adapt(): void {
    const target = 1000 / this.o.targetFps;
    if (this.emaMs > target * 1.3) {
      this.badFrames++;
      this.goodFrames = 0;
      if (this.badFrames >= 20) {
        this.badFrames = 0;
        this.active = Math.max(this.o.minParticleCount, Math.floor(this.active * 0.8));
      }
    } else if (this.emaMs < target * 1.1) {
      this.goodFrames++;
      this.badFrames = 0;
      if (this.goodFrames >= 180 && this.active < this.allocatedCount) {
        this.goodFrames = 0;
        this.active = Math.min(this.allocatedCount, Math.ceil(this.active * 1.1));
      }
    } else {
      this.badFrames = 0;
      this.goodFrames = 0;
    }
  }

  private updateStats(static_: boolean): void {
    const s = this.stats;
    s.frameMs = this.emaMs;
    s.fps = 1000 / this.emaMs;
    s.particles = static_ ? Math.min(this.allocatedCount, STATIC_MAX_PARTICLES) : this.active;
    s.maxParticles = this.allocatedCount;
    s.state = this.stateKind;
    s.projection = this.projName;
    s.reducedMotion = static_;
    s.ready = true;
  }
}

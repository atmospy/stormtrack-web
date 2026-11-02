import type { CustomLayerInterface, CustomRenderMethodInput, Map as MlMap } from 'maplibre-gl';

/**
 * Animated lightning as a MapLibre custom WebGL layer (works with the globe and with mercator).
 *
 * Every strike is one instance (20 bytes: mercator x, y, start time, size, mode) in a ring buffer that lives in a
 * Float32Array on the CPU and in one GL buffer. A frame is a few instanced draw calls with a single `u_now` uniform;
 * all the animation is computed in the shaders from (now - start), so there is no per-frame JavaScript allocation
 * and no per-strike work on the CPU after it was added.
 *
 *   mode 0  flash : bright core (~120 ms) + expanding ring (1.5 s) + afterglow dot
 *   mode 1  dim   : afterglow only (backlog, late arrivals, over budget or merged strikes)
 *   mode 2  soft  : "reduce flashing": no core, no ring, the dot fades in gently over ~0.9 s
 *
 * Afterglow: bright decay with a 18 s time constant plus a faint tail that fades out at the chosen window; the
 * colour shifts white -> yellow -> orange -> red-purple with log(age), so a glance shows how fresh a cell is.
 */

export const MODE_FLASH = 0;
export const MODE_DIM = 1;
export const MODE_SOFT = 2;

const STRIDE = 5; // floats per instance
const MERC_LAT = 85.0511287798;

export interface LightningLayerOptions {
  id?: string;
  /** ring buffer size (instances). 65 536 = 1.3 MB */
  capacity?: number;
  /** playback clock, unix ms (the same timeline as strike t_ms) */
  clock: () => number;
  /** visible age limit, seconds */
  windowS?: number;
}

const VS = (prelude: string, define: string) => `#version 300 es
precision highp float;
precision highp int;
${prelude}
${define}
layout(location = 0) in vec2 a_pos;     // mercator [0,1]
layout(location = 1) in vec3 a_data;    // start (s), size 0..1, mode
uniform float u_now;
uniform float u_window;
uniform vec2 u_viewport;
uniform float u_dpr;
uniform float u_x_off;
out vec2 v_local;
out float v_age;
out float v_size;
out float v_mode;
void main() {
  float age = u_now - a_data.x;
  float size = a_data.y;
  float mode = a_data.z;
  v_age = age; v_size = size; v_mode = mode; v_local = vec2(0.0);
  if (age < 0.0 || age > u_window) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vec4 c = projectTile(a_pos + vec2(u_x_off, 0.0));
  if (c.w <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  float glowR = mix(2.0, 4.0, size);
  float ringMax = mix(12.0, 30.0, size);
  float ext = (mode < 0.5 && age < 1.5) ? ringMax + 4.0 : glowR * 1.9 + 1.0;
  vec2 corner = vec2(float(gl_VertexID & 1) * 2.0 - 1.0, float(gl_VertexID >> 1) * 2.0 - 1.0);
  vec2 ndc = c.xy / c.w + corner * ext * u_dpr / (u_viewport * 0.5);
  gl_Position = vec4(ndc * c.w, c.z, c.w);
  v_local = corner * ext;
}`;

const FS = `#version 300 es
precision highp float;
in vec2 v_local;
in float v_age;
in float v_size;
in float v_mode;
uniform float u_window;
uniform float u_glow;
out vec4 fragColor;

vec3 glowColor(float age) {
  float x = clamp(log(1.0 + age) / log(3601.0), 0.0, 1.0);
  vec3 c0 = vec3(1.00, 0.97, 0.82);
  vec3 c1 = vec3(1.00, 0.82, 0.35);
  vec3 c2 = vec3(1.00, 0.52, 0.18);
  vec3 c3 = vec3(0.86, 0.26, 0.32);
  vec3 c4 = vec3(0.56, 0.20, 0.42);
  vec3 c = mix(c0, c1, smoothstep(0.0, 0.3, x));
  c = mix(c, c2, smoothstep(0.3, 0.55, x));
  c = mix(c, c3, smoothstep(0.55, 0.8, x));
  return mix(c, c4, smoothstep(0.8, 1.0, x));
}

void main() {
  float r = length(v_local);          // CSS px from the strike
  float age = v_age;
  float size = v_size;
  float glowR = mix(2.0, 4.0, size);

  // afterglow dot + soft halo
  float fade = v_mode > 1.5 ? smoothstep(0.0, 0.9, age) : smoothstep(0.0, 0.12, age);
  float decay = 0.85 * exp(-age / 18.0) + 0.22 * pow(max(0.0, 1.0 - age / u_window), 1.5);
  float dotA = 1.0 - smoothstep(glowR - 1.0, glowR + 0.6, r);
  float halo = 0.30 * exp(-(r * r) / (glowR * glowR * 2.2));
  float ga = clamp((dotA + halo) * decay * fade * u_glow, 0.0, 1.0);
  vec3 rgb = glowColor(age) * ga;
  float a = ga;

  if (v_mode < 0.5) {
    // core flash: <= 14 px across, 120 ms
    float coreR = (5.0 + 9.0 * size) * 0.5;
    float k = clamp(1.0 - age / 0.12, 0.0, 1.0);
    float core = (1.0 - smoothstep(coreR * 0.45, coreR, r)) * k * k;
    rgb += vec3(0.86, 0.94, 1.0) * core;
    a += core;
    // ring: 1.6 px outline, 1.5 s
    float t = age / 1.5;
    if (t < 1.0) {
      float ringMax = mix(12.0, 30.0, size);
      float ringR = ringMax * (1.0 - pow(1.0 - t, 2.5));
      float line = 1.0 - smoothstep(0.0, 1.6, abs(r - ringR));
      float ra = line * pow(1.0 - t, 1.6) * (0.45 + 0.4 * size);
      rgb += vec3(0.55, 0.78, 1.0) * ra;
      a += ra * 0.8;
    }
  }
  fragColor = vec4(min(rgb, vec3(1.0)), min(a, 1.0));
}`;

interface ProjData {
  mainMatrix: ArrayLike<number>;
  fallbackMatrix: ArrayLike<number>;
  tileMercatorCoords: ArrayLike<number>;
  clippingPlane: ArrayLike<number>;
  projectionTransition: number;
}

export class LightningGLLayer implements CustomLayerInterface {
  readonly id: string;
  readonly type = 'custom' as const;
  readonly renderingMode = '2d' as const;
  visible = true;
  /** multiplies the afterglow brightness (the HUD could expose it) */
  glow = 1;
  readonly capacity: number;
  private readonly data: Float32Array;
  private head = 0;
  private count = 0;
  private dirtyLo = Infinity;
  private dirtyHi = -1;
  private all = true;
  private readonly epochMs: number;
  private readonly clock: () => number;
  private windowS: number;
  private lastAddSec = -1e9;
  private map: MlMap | null = null;
  private gl: WebGL2RenderingContext | null = null;
  private buf: WebGLBuffer | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private progs = new Map<string, { prog: WebGLProgram; u: Record<string, WebGLUniformLocation | null> }>();
  private mat = new Float32Array(16);
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** counters for tests and the HUD */
  stats = { added: 0, drawCalls: 0, instances: 0, frames: 0 };

  constructor(o: LightningLayerOptions) {
    this.id = o.id ?? 'lightning-gl';
    this.capacity = o.capacity ?? 65_536;
    this.data = new Float32Array(this.capacity * STRIDE);
    this.clock = o.clock;
    this.epochMs = Math.floor(o.clock());
    this.windowS = o.windowS ?? 900;
  }

  get size(): number {
    return this.count;
  }
  setWindowS(s: number): void {
    this.windowS = s;
    this.map?.triggerRepaint();
  }
  setVisible(v: boolean): void {
    this.visible = v;
    if (!v && this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.map?.triggerRepaint();
  }
  clear(): void {
    this.head = 0;
    this.count = 0;
    this.all = true;
    this.map?.triggerRepaint();
  }

  /** Add one strike. `tMs` is on the playback timeline; for a live strike that is "now". */
  add(lon: number, lat: number, tMs: number, size: number, mode: number): void {
    const i = this.head * STRIDE;
    const d = this.data;
    const la = Math.max(-MERC_LAT, Math.min(MERC_LAT, lat));
    const s = Math.sin((la * Math.PI) / 180);
    d[i] = (lon + 180) / 360;
    d[i + 1] = 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
    const startSec = (tMs - this.epochMs) / 1000;
    d[i + 2] = startSec;
    d[i + 3] = size;
    d[i + 4] = mode;
    if (this.head < this.dirtyLo) this.dirtyLo = this.head;
    if (this.head > this.dirtyHi) this.dirtyHi = this.head;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
    if (this.head === 0) this.all = true; // wrapped: simplest is a full upload
    if (mode !== MODE_DIM && startSec > this.lastAddSec) this.lastAddSec = startSec;
    this.stats.added++;
  }

  /** Request a repaint after a batch of adds. */
  flush(): void {
    this.map?.triggerRepaint();
  }

  // ------------------------------------------------------------------ CustomLayerInterface
  onAdd(map: MlMap, gl: WebGL2RenderingContext): void {
    this.map = map;
    this.gl = gl;
    this.progs.clear();
    this.buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferData(gl.ARRAY_BUFFER, this.data.byteLength, gl.DYNAMIC_DRAW);
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, STRIDE * 4, 0);
    gl.vertexAttribDivisor(0, 1);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, STRIDE * 4, 8);
    gl.vertexAttribDivisor(1, 1);
    gl.bindVertexArray(null);
    this.all = true;
  }

  onRemove(): void {
    const gl = this.gl;
    if (gl) {
      if (this.buf) gl.deleteBuffer(this.buf);
      if (this.vao) gl.deleteVertexArray(this.vao);
      for (const p of this.progs.values()) gl.deleteProgram(p.prog);
    }
    this.progs.clear();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.map = null;
    this.gl = null;
    this.buf = null;
    this.vao = null;
  }

  private program(gl: WebGL2RenderingContext, args: CustomRenderMethodInput) {
    const key = args.shaderData.variantName;
    let p = this.progs.get(key);
    if (p) return p;
    const mk = (type: number, src: string) => {
      const sh = gl.createShader(type)!;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(sh);
        gl.deleteShader(sh);
        throw new Error(`lightning-layer: shader compile failed: ${log}`);
      }
      return sh;
    };
    const v = mk(gl.VERTEX_SHADER, VS(args.shaderData.vertexShaderPrelude, args.shaderData.define));
    const f = mk(gl.FRAGMENT_SHADER, FS);
    const prog = gl.createProgram()!;
    gl.attachShader(prog, v);
    gl.attachShader(prog, f);
    gl.linkProgram(prog);
    gl.deleteShader(v);
    gl.deleteShader(f);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(`lightning-layer: link failed: ${gl.getProgramInfoLog(prog)}`);
    const u: Record<string, WebGLUniformLocation | null> = {};
    const n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS) as number;
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(prog, i);
      if (info) u[info.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(prog, info.name);
    }
    p = { prog, u };
    this.progs.set(key, p);
    return p;
  }

  render(gl: WebGL2RenderingContext, args: CustomRenderMethodInput): void {
    if (!this.visible || this.count === 0 || !this.buf || !this.vao || !this.map) return;
    const map = this.map;
    let p;
    try {
      p = this.program(gl, args);
    } catch (e) {
      this.visible = false;
      console.error(e instanceof Error ? e.message : e);
      return;
    }
    // upload only what changed
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    if (this.all) {
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.data, 0, this.count * STRIDE);
    } else if (this.dirtyHi >= this.dirtyLo) {
      const lo = this.dirtyLo * STRIDE;
      gl.bufferSubData(gl.ARRAY_BUFFER, lo * 4, this.data, lo, (this.dirtyHi + 1) * STRIDE - lo);
    }
    this.all = false;
    this.dirtyLo = Infinity;
    this.dirtyHi = -1;

    const nowSec = (this.clock() - this.epochMs) / 1000;
    const pd = args.defaultProjectionData as unknown as ProjData;
    gl.useProgram(p.prog);
    const u = p.u;
    const setMat = (loc: WebGLUniformLocation | null | undefined, m: ArrayLike<number>) => {
      if (!loc) return;
      this.mat.set(m);
      gl.uniformMatrix4fv(loc, false, this.mat);
    };
    setMat(u.u_projection_matrix, pd.mainMatrix);
    setMat(u.u_projection_fallback_matrix, pd.fallbackMatrix);
    if (u.u_projection_tile_mercator_coords) gl.uniform4fv(u.u_projection_tile_mercator_coords, pd.tileMercatorCoords as Float32List);
    if (u.u_projection_clipping_plane) gl.uniform4fv(u.u_projection_clipping_plane, pd.clippingPlane as Float32List);
    if (u.u_projection_transition) gl.uniform1f(u.u_projection_transition, pd.projectionTransition);
    gl.uniform1f(u.u_now!, nowSec);
    gl.uniform1f(u.u_window!, this.windowS);
    gl.uniform2f(u.u_viewport!, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.uniform1f(u.u_dpr!, map.getPixelRatio());
    gl.uniform1f(u.u_glow!, this.glow);

    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.STENCIL_TEST);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.SCISSOR_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindVertexArray(this.vao);

    // world copies: only in flat rendering (a fully-globe view needs just the one)
    const globe = args.shaderData.define.indexOf('GLOBE') >= 0 && pd.projectionTransition > 0.999;
    const k0 = globe ? 0 : Math.round(map.getCenter().lng / 360) - 1;
    const k1 = globe ? 0 : k0 + 2;
    let calls = 0;
    for (let k = k0; k <= k1; k++) {
      gl.uniform1f(u.u_x_off!, k);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.count);
      calls++;
    }
    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);
    this.stats.drawCalls += calls;
    this.stats.instances = this.count;
    this.stats.frames++;

    // keep animating: every frame while a flash is young, slowly while the afterglow decays
    if (nowSec - this.lastAddSec < 1.8) map.triggerRepaint();
    else if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        if (this.visible) this.map?.triggerRepaint();
      }, nowSec - this.lastAddSec < 70 ? 250 : 1500);
    }
  }
}

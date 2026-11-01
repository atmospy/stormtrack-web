import type { CustomLayerInterface, CustomRenderMethodInput, Map as MaplibreMap } from 'maplibre-gl';
import { decodeScalarImage, isGlobalLon, sampleScalar } from './decode.js';
import { createProgram, makeTexture, type Program } from './gl.js';
import { SCALAR_RAMPS, buildRampLUT } from './ramp.js';
import { FRAGMENT, vertexSource } from './shaders.js';
import type { DecodedScalar, ScalarFrameMeta, ScalarImageSource, ScalarLayerOptions, ScalarRamp } from './types.js';

const U = { a: 0, b: 1, ramp: 2 } as const;
const RAMP_SIZE = 512;
/** mesh resolution in degrees; chords of 1 deg deviate from the sphere by < 0.004 % of the radius */
const STEP = 1;
const MAX_LAT = 89.99;
/** world copies drawn in flat projections: -2..2 */
const COPIES = 5;

type ProjData = CustomRenderMethodInput['defaultProjectionData'];

interface Slot {
  src: ScalarImageSource;
  meta: ScalarFrameMeta;
  tex: WebGLTexture | null;
  dec: DecodedScalar | null;
}

const mercY = (lat: number) => 0.5 - Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / (2 * Math.PI);

/** Physical range the ramp is spread over by default (squares an "encoded" sqrt range). */
export function physicalRange(meta: ScalarFrameMeta): [number, number] {
  if (meta.transform === 'sqrt' && meta.rangeIn === 'encoded') return [meta.range[0] ** 2, meta.range[1] ** 2];
  return [meta.range[0], meta.range[1]];
}

/**
 * GPU colour-mapped scalar field as a MapLibre custom layer (globe + mercator). The PNG is uploaded as an RGBA8
 * NEAREST texture and interpolated bilinearly in the shader after rebuilding the 16-bit code (see shaders.ts).
 * All GL work happens inside MapLibre's `render` callback so its cached GL state is never corrupted.
 */
export class ScalarLayer implements CustomLayerInterface {
  readonly id: string;
  readonly type = 'custom' as const;
  readonly renderingMode = '2d' as const;

  private ramp: ScalarRamp;
  private opacity: number;
  private valueRange: [number, number] | null;
  private visible: boolean;
  private map: MaplibreMap | null = null;
  private gl: WebGL2RenderingContext | null = null;
  private lost = false;
  private destroyed = false;

  private slotA: Slot | null = null;
  private slotB: Slot | null = null;
  private mixV = 0;
  private trash: WebGLTexture[] = [];

  private programs = new Map<string, Program>();
  private vao: WebGLVertexArrayObject | null = null;
  private vbo: WebGLBuffer | null = null;
  private ibo: WebGLBuffer | null = null;
  private indexCount = 0;
  private rampTex: WebGLTexture | null = null;
  private rampKey = '';

  constructor(opts: ScalarLayerOptions = {}) {
    this.id = opts.id ?? 'scalar';
    this.ramp = opts.ramp ?? SCALAR_RAMPS.viridis;
    this.opacity = opts.opacity ?? 0.8;
    this.valueRange = opts.valueRange ?? null;
    this.visible = opts.visible ?? true;
  }

  // ------------------------------------------------------------------ public API

  /** Set the frame to show; `nextImage` (same meta) plus `mix` 0..1 blends two forecast hours inside the shader. */
  setFrame(meta: ScalarFrameMeta, image: ScalarImageSource, nextImage?: ScalarImageSource | null, mix = 0): void {
    if (this.destroyed) return;
    const reuse = (src: ScalarImageSource): Slot | null => {
      for (const s of [this.slotA, this.slotB]) if (s && s.src === src && s.meta === meta) return s;
      return null;
    };
    const a = reuse(image) ?? { src: image, meta, tex: null, dec: null };
    const b = nextImage ? (reuse(nextImage) ?? { src: nextImage, meta, tex: null, dec: null }) : null;
    // free textures of slots that are no longer used
    for (const old of [this.slotA, this.slotB]) {
      if (old && old !== a && old !== b && old.tex) {
        this.trash.push(old.tex);
        old.tex = null;
      }
    }
    this.slotA = a;
    this.slotB = b;
    this.mixV = Math.min(Math.max(mix, 0), 1);
    this.map?.triggerRepaint();
  }

  setMix(mix: number): void {
    this.mixV = Math.min(Math.max(mix, 0), 1);
    this.map?.triggerRepaint();
  }

  setRamp(ramp: ScalarRamp): void {
    this.ramp = ramp;
    this.map?.triggerRepaint();
  }

  setOptions(o: { opacity?: number; valueRange?: [number, number] | null; ramp?: ScalarRamp }): void {
    if (o.opacity !== undefined) this.opacity = o.opacity;
    if (o.valueRange !== undefined) this.valueRange = o.valueRange;
    if (o.ramp) this.ramp = o.ramp;
    this.map?.triggerRepaint();
  }

  setVisible(v: boolean): void {
    this.visible = v;
    this.map?.triggerRepaint();
  }

  /** The decoded (physical-unit) field of the current frame, decoded lazily and cached. For contours/meteograms. */
  getDecoded(which: 'a' | 'b' = 'a'): DecodedScalar | null {
    const s = which === 'a' ? this.slotA : this.slotB;
    if (!s) return null;
    return (s.dec ??= decodeScalarImage(s.src, s.meta));
  }

  /** Value at lon/lat in physical units (bilinear, longitude-wrap-safe, blended by the current mix); null if no data. */
  sample(lon: number, lat: number): number | null {
    const a = this.getDecoded('a');
    if (!a) return null;
    const va = sampleScalar(a, lon, lat);
    if (va === null || !this.slotB || this.mixV <= 0) return va;
    const b = this.getDecoded('b');
    const vb = b ? sampleScalar(b, lon, lat) : null;
    return vb === null ? va : va + (vb - va) * this.mixV;
  }

  destroy(): void {
    this.destroyed = true;
    this.map?.removeLayer(this.id);
    this.releaseGL();
    this.slotA = this.slotB = null;
  }

  // ------------------------------------------------------------------ CustomLayerInterface

  onAdd(map: MaplibreMap, gl: WebGL2RenderingContext): void {
    this.map = map;
    this.gl = gl;
    this.lost = false;
    this.destroyed = false;
    const canvas = map.getCanvas();
    canvas.addEventListener('webglcontextlost', this.onLost);
    canvas.addEventListener('webglcontextrestored', this.onRestored);
  }

  onRemove(map: MaplibreMap): void {
    const canvas = map.getCanvas();
    canvas.removeEventListener('webglcontextlost', this.onLost);
    canvas.removeEventListener('webglcontextrestored', this.onRestored);
    this.releaseGL();
    this.map = null;
    this.gl = null;
  }

  render(gl: WebGL2RenderingContext, args: CustomRenderMethodInput): void {
    if (!this.visible || this.lost || !this.slotA) return;
    try {
      this.draw(gl, args);
    } catch (e) {
      this.visible = false;
      console.error('[scalar-layer] disabled after GL error: ' + (e instanceof Error ? e.message : String(e)));
    }
  }

  // ------------------------------------------------------------------ internals

  private onLost = (e: Event): void => {
    e.preventDefault();
    this.lost = true;
  };

  private onRestored = (): void => {
    // every GL object died with the context; drop references and rebuild lazily
    this.programs.clear();
    this.vao = this.vbo = this.ibo = null;
    this.rampTex = null;
    this.rampKey = '';
    this.trash.length = 0;
    if (this.slotA) this.slotA.tex = null;
    if (this.slotB) this.slotB.tex = null;
    this.lost = false;
    this.map?.triggerRepaint();
  };

  private releaseGL(): void {
    const gl = this.gl;
    if (gl && !this.lost) {
      for (const s of [this.slotA, this.slotB]) if (s?.tex) gl.deleteTexture(s.tex);
      for (const t of this.trash) gl.deleteTexture(t);
      if (this.rampTex) gl.deleteTexture(this.rampTex);
      if (this.vao) gl.deleteVertexArray(this.vao);
      if (this.vbo) gl.deleteBuffer(this.vbo);
      if (this.ibo) gl.deleteBuffer(this.ibo);
      for (const p of this.programs.values()) gl.deleteProgram(p.prog);
    }
    for (const s of [this.slotA, this.slotB]) if (s) s.tex = null;
    this.trash.length = 0;
    this.programs.clear();
    this.vao = this.vbo = this.ibo = this.rampTex = null;
    this.rampKey = '';
  }

  private buildMesh(gl: WebGL2RenderingContext): void {
    const nx = Math.round(360 / STEP) + 1;
    const lats: number[] = [];
    for (let lat = -89; lat <= 89; lat += STEP) lats.push(lat);
    // make sure the mercator world edge is an exact row, so flat views have no sliver at +-85.05
    const edge = (Math.atan(Math.sinh(Math.PI)) * 180) / Math.PI;
    for (const e of [-edge, edge, -MAX_LAT, MAX_LAT]) if (!lats.some((l) => Math.abs(l - e) < 1e-3)) lats.push(e);
    lats.sort((p, q) => p - q);
    const ny = lats.length;
    const verts = new Float32Array(nx * ny * 2);
    for (let j = 0; j < ny; j++) {
      const y = mercY(lats[j]!);
      for (let i = 0; i < nx; i++) {
        verts[(j * nx + i) * 2] = i / (nx - 1);
        verts[(j * nx + i) * 2 + 1] = y;
      }
    }
    const idx = new Uint32Array((nx - 1) * (ny - 1) * 6);
    let k = 0;
    for (let j = 0; j < ny - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
        idx.set([a, b, c, b, d, c], k);
        k += 6;
      }
    }
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    this.vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
    this.ibo = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    this.indexCount = idx.length;
    // attribute 0 = a_merc (bound by explicit location below once a program exists)
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }

  private upload(gl: WebGL2RenderingContext, s: Slot): void {
    if (s.tex) return;
    const tex = makeTexture(gl, { filter: gl.NEAREST });
    gl.bindTexture(gl.TEXTURE_2D, tex);
    // raw data bytes: no colour management, no premultiply, no flip
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    const src = s.src as ImageData;
    if (typeof ImageData === 'undefined' && (src as { data?: ArrayLike<number> }).data) {
      const d = src.data as unknown as Uint8Array;
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, src.width, src.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(d.buffer));
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, s.src as TexImageSource);
    }
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.BROWSER_DEFAULT_WEBGL);
    s.tex = tex;
  }

  private updateRamp(gl: WebGL2RenderingContext, meta: ScalarFrameMeta, range: [number, number]): void {
    const sq = meta.transform === 'sqrt';
    const key = JSON.stringify([this.ramp, range, sq]);
    if (this.rampTex && key === this.rampKey) return;
    if (!this.rampTex) this.rampTex = makeTexture(gl, { filter: gl.LINEAR });
    gl.bindTexture(gl.TEXTURE_2D, this.rampTex);
    const lut = buildRampLUT(this.ramp, range, sq, RAMP_SIZE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, RAMP_SIZE, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, lut);
    this.rampKey = key;
  }

  private program(gl: WebGL2RenderingContext, args: CustomRenderMethodInput): Program {
    const key = args.shaderData.variantName;
    let p = this.programs.get(key);
    if (!p) {
      const vs = vertexSource(args.shaderData.vertexShaderPrelude, args.shaderData.define);
      // pin a_merc to location 0 so the VAO built once works for every projection variant
      p = createProgram(gl, vs, FRAGMENT, { a_merc: 0 });
      this.programs.set(key, p);
    }
    return p;
  }

  private draw(gl: WebGL2RenderingContext, args: CustomRenderMethodInput): void {
    for (const t of this.trash.splice(0)) gl.deleteTexture(t);
    const a = this.slotA!;
    const b = this.slotB;
    if (!this.vao) this.buildMesh(gl);
    this.upload(gl, a);
    if (b) this.upload(gl, b);
    const meta = a.meta;
    const range = this.valueRange ?? physicalRange(meta);
    this.updateRamp(gl, meta, range);

    const p = this.program(gl, args);
    gl.useProgram(p.prog);
    gl.activeTexture(gl.TEXTURE0 + U.a);
    gl.bindTexture(gl.TEXTURE_2D, a.tex!);
    gl.activeTexture(gl.TEXTURE0 + U.b);
    gl.bindTexture(gl.TEXTURE_2D, (b ?? a).tex!);
    gl.activeTexture(gl.TEXTURE0 + U.ramp);
    gl.bindTexture(gl.TEXTURE_2D, this.rampTex!);
    const u = p.u;
    const g = meta.grid;
    const dx = (g.lon_right - g.lon_left) / (g.width - 1);
    const dy = (g.lat_top - g.lat_bottom) / (g.height - 1);
    gl.uniform1i(u.u_a!, U.a);
    gl.uniform1i(u.u_b!, U.b);
    gl.uniform1i(u.u_ramp!, U.ramp);
    gl.uniform1f(u.u_mix!, b ? this.mixV : 0);
    gl.uniform1f(u.u_has_b!, b ? 1 : 0);
    gl.uniform2f(u.u_range!, meta.range[0], meta.range[1]);
    gl.uniform1f(u.u_sqrt!, meta.transform === 'sqrt' ? 1 : 0);
    gl.uniform1f(u.u_enc_range!, meta.rangeIn === 'encoded' ? 1 : 0);
    gl.uniform2f(u.u_vrange!, range[0], range[1]);
    gl.uniform4f(u.u_grid!, g.lon_left, g.lat_top, dx, dy);
    gl.uniform2f(u.u_size!, g.width, g.height);
    gl.uniform1f(u.u_global!, isGlobalLon(g) ? 1 : 0);
    gl.uniform1f(u.u_opacity!, this.opacity);

    const pd: ProjData = args.defaultProjectionData;
    const setMat = (loc: WebGLUniformLocation | null | undefined, m: ArrayLike<number>) => {
      if (loc) gl.uniformMatrix4fv(loc, false, Float32Array.from(m as ArrayLike<number>));
    };
    setMat(u.u_projection_matrix, pd.mainMatrix);
    setMat(u.u_projection_fallback_matrix, pd.fallbackMatrix);
    if (u.u_projection_tile_mercator_coords) gl.uniform4fv(u.u_projection_tile_mercator_coords, pd.tileMercatorCoords);
    if (u.u_projection_clipping_plane) gl.uniform4fv(u.u_projection_clipping_plane, pd.clippingPlane);
    if (u.u_projection_transition) gl.uniform1f(u.u_projection_transition, pd.projectionTransition);

    const fullGlobe = args.shaderData.define.indexOf('GLOBE') >= 0 && pd.projectionTransition > 0.999;
    gl.uniform1f(u.u_clip!, fullGlobe ? 0 : 1);

    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.STENCIL_TEST);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.SCISSOR_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindVertexArray(this.vao);
    if (fullGlobe) {
      gl.uniform1f(u.u_x_off!, 0);
      gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_INT, 0);
    } else {
      for (let k = 0; k < COPIES; k++) {
        gl.uniform1f(u.u_x_off!, k - 2);
        gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_INT, 0);
      }
    }
    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);
  }
}

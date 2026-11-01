/**
 * GLSL ES 3.00 sources. No vertex buffers anywhere: particles are instances, the quad corner comes from
 * gl_VertexID, and particle state lives in a texture read with texelFetch.
 *
 * Coordinate convention: particle positions are web-mercator "world" coordinates in [0,1]^2
 * (x east from -180 deg, y south from +85.05 deg) - exactly what MapLibre's projectTile() expects.
 */

const HEAD = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
`;

/** Shared: sample the (two) wind textures at a mercator position. Wrapping/clamping is done by texture params. */
const WIND_COMMON = `
uniform sampler2D u_wind_a;
uniform sampler2D u_wind_b;
uniform float u_mix;
uniform vec2 u_urange;   // m/s for R = 0 / 255
uniform vec2 u_vrange;   // m/s for G = 0 / 255
uniform vec4 u_grid;     // lon_left, lat_top, dlon, dlat  (degrees, positive steps)
uniform vec2 u_size;     // texture width, height
uniform float u_global;  // 1 when the grid spans 360 deg (REPEAT in x)

// returns (u m/s, v m/s, inside 0/1)
vec3 windAt(vec2 merc) {
  float lon = merc.x * 360.0 - 180.0;
  float lat = degrees(atan(sinh(PI * (1.0 - 2.0 * merc.y))));
  float fx = (lon - u_grid.x) / u_grid.z + 0.5;
  float fy = (u_grid.y - lat) / u_grid.w + 0.5;
  float inside = 1.0;
  if (u_global < 0.5) {
    inside = (fx >= 0.0 && fx <= u_size.x && fy >= 0.0 && fy <= u_size.y) ? 1.0 : 0.0;
  } else {
    inside = (fy >= 0.0 && fy <= u_size.y) ? 1.0 : 0.0;
  }
  vec2 uv = vec2(fx / u_size.x, fy / u_size.y);
  vec4 a = texture(u_wind_a, uv);
  vec4 b = texture(u_wind_b, uv);
  vec4 c = mix(a, b, u_mix);
  return vec3(mix(u_urange.x, u_urange.y, c.r), mix(u_vrange.x, u_vrange.y, c.g), inside);
}
`;

const STATE_CODEC = `
#ifdef PACK8
vec2 decodePos(vec4 c) { return vec2(c.b + c.r / 255.0, c.a + c.g / 255.0); }
vec4 encodePos(vec2 p) {
  vec2 s = p * 255.0;
  vec2 hi = floor(s) / 255.0;
  vec2 lo = fract(s);
  return vec4(lo.x, lo.y, hi.x, hi.y);
}
#else
vec2 decodePos(vec4 c) { return c.xy; }
vec4 encodePos(vec2 p) { return vec4(p, 0.0, 1.0); }
#endif
`;

export const FULLSCREEN_VS = `${HEAD}
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

/** Particle update: advect by wind, random respawn inside the visible mercator rectangle. */
export function updateFragmentSource(pack8: boolean): string {
  return `${HEAD}${pack8 ? '#define PACK8\n' : ''}const float PI = 3.141592653589793;
${WIND_COMMON}${STATE_CODEC}
uniform sampler2D u_state;
uniform float u_step;        // mercator units per (m/s) at the equator
uniform float u_seed;
uniform float u_drop;
uniform float u_drop_bump;
uniform float u_speed_max;
uniform vec4 u_view;         // x0, y0, x1, y1 in mercator (x may be outside 0..1 / span >= 1 means whole world)
uniform float u_reseed;      // 1 = place every particle deterministically in the view (static mode)
out vec4 fragColor;

float rand(vec2 co) {
  return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453);
}

vec2 spawn(vec2 seed) {
  float rx = rand(seed + 1.3);
  float ry = rand(seed + 7.1);
  float x = fract(u_view.x + rx * (u_view.z - u_view.x));
  float y = clamp(u_view.y + ry * (u_view.w - u_view.y), 0.0005, 0.9995);
  return vec2(x, y);
}

void main() {
  ivec2 tc = ivec2(gl_FragCoord.xy);
  vec2 cell = vec2(tc) + 0.5;
  if (u_reseed > 0.5) {
    fragColor = encodePos(spawn(cell * 0.0173 + u_seed));
    return;
  }
  vec2 pos = decodePos(texelFetch(u_state, tc, 0));
  vec3 w = windAt(pos);
  float speed = length(w.xy);
  float coshLat = min(cosh(PI * (1.0 - 2.0 * pos.y)), 4.0);
  vec2 d = vec2(w.x, -w.y) * u_step * coshLat;
  vec2 np = vec2(pos.x + d.x, pos.y + d.y);
  np.x = fract(np.x);

  vec2 seed = pos * 77.0 + cell * 0.0071 + u_seed;
  float dropP = u_drop + clamp(speed / u_speed_max, 0.0, 1.0) * u_drop_bump;
  bool drop = rand(seed) < dropP || w.z < 0.5 || np.y < 0.0 || np.y > 1.0;

  float spanx = u_view.z - u_view.x;
  if (spanx < 0.999) {
    float rel = fract(np.x - u_view.x);
    if (rel > spanx) drop = true;
  }
  if (np.y < u_view.y || np.y > u_view.w) drop = true;

  if (drop) np = spawn(seed);
  fragColor = encodePos(np);
}`;
}

/** Particle draw: one instance per particle = one screen-space quad from previous to current position. */
export function drawVertexSource(prelude: string, define: string, pack8: boolean): string {
  return `${HEAD}${pack8 ? '#define PACK8\n' : ''}
${prelude}
${define}
${WIND_COMMON}${STATE_CODEC}
uniform sampler2D u_state;
uniform sampler2D u_prev;
uniform sampler2D u_ramp;
uniform int u_state_w;
uniform vec2 u_viewport;     // drawing-buffer size in px
uniform float u_half_width;  // px (device)
uniform float u_x_off;       // world copy offset
uniform float u_max_delta;   // max plausible mercator step per frame at the equator
uniform float u_ramp_max;    // m/s of the last ramp texel
uniform float u_static;      // 1: draw a fixed-length streamline instead of prev->cur
uniform float u_static_len;  // mercator units per (m/s) for static streamlines
out vec4 v_color;
out float v_side;
out float v_alpha;

void main() {
  int id = gl_InstanceID;
  ivec2 tc = ivec2(id % u_state_w, id / u_state_w);
  vec2 cur = decodePos(texelFetch(u_state, tc, 0));
  vec3 w = windAt(cur);
  float speed = length(w.xy);
  float coshLat = min(cosh(PI * (1.0 - 2.0 * cur.y)), 4.0);
  vec2 prev;
  bool ok = w.z > 0.5;
  if (u_static > 0.5) {
    prev = cur - vec2(w.x, -w.y) * u_static_len * coshLat;
    ok = ok && speed > 0.2;
  } else {
    prev = decodePos(texelFetch(u_prev, tc, 0));
    vec2 dl = cur - prev;
    ok = ok && length(dl) < u_max_delta * coshLat * 3.0 + 1e-6;
  }
  cur.x += u_x_off;
  prev.x += u_x_off;

  int corner = gl_VertexID;          // 0,1 = tail  2,3 = head (triangle strip)
  bool head = corner >= 2;
  float side = (corner & 1) == 0 ? -1.0 : 1.0;

  vec4 cc = projectTile(cur);
  vec4 cp = projectTile(prev);
  if (!ok || cc.w <= 0.0 || cp.w <= 0.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    v_color = vec4(0.0);
    v_side = 0.0;
    v_alpha = 0.0;
    return;
  }
  vec2 half_vp = u_viewport * 0.5;
  vec2 sc = cc.xy / cc.w * half_vp;
  vec2 sp = cp.xy / cp.w * half_vp;
  vec2 dir = sc - sp;
  float len = length(dir);
  dir = len > 1e-4 ? dir / len : vec2(1.0, 0.0);
  vec2 perp = vec2(-dir.y, dir.x);
  float hw = u_half_width + 0.5;
  vec4 base = head ? cc : cp;
  vec2 sbase = head ? sc : sp;
  vec2 ext = head ? dir * hw : vec2(0.0);
  vec2 s = sbase + ext + perp * side * hw;
  gl_Position = vec4(s / half_vp * base.w, base.z, base.w);

  float t = clamp(speed / u_ramp_max, 0.0, 1.0);
  vec4 rc = texture(u_ramp, vec2(t * (1.0 - 1.0 / 256.0) + 0.5 / 256.0, 0.5));
  v_color = vec4(rc.rgb, rc.a);
  v_side = side * hw / (u_half_width + 0.5);
  v_alpha = (u_static > 0.5) ? (head ? 1.0 : 0.12) : 1.0;
}`;
}

export const DRAW_FRAGMENT = `${HEAD}
uniform float u_half_width;
in vec4 v_color;
in float v_side;
in float v_alpha;
out vec4 fragColor;
void main() {
  float dist = abs(v_side) * (u_half_width + 0.5);
  float cover = clamp(u_half_width + 0.5 - dist, 0.0, 1.0);
  float a = v_color.a * cover * v_alpha;
  fragColor = vec4(v_color.rgb * a, a);
}`;

/** trail = trail * fade - epsilon (the epsilon removes the 8-bit "ghost" residue that pure multiplication leaves) */
export const FADE_FRAGMENT = `${HEAD}
uniform sampler2D u_trail;
uniform float u_fade;
out vec4 fragColor;
void main() {
  vec4 c = texelFetch(u_trail, ivec2(gl_FragCoord.xy), 0);
  c = max(c * u_fade - vec4(1.5 / 255.0), vec4(0.0));
  fragColor = c;
}`;

export const COMPOSITE_FRAGMENT = `${HEAD}
uniform sampler2D u_trail;
uniform float u_opacity;
out vec4 fragColor;
void main() {
  fragColor = texelFetch(u_trail, ivec2(gl_FragCoord.xy), 0) * u_opacity;
}`;

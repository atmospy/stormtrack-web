/**
 * GLSL ES 3.00. A static lon/lat mesh (stored as web-mercator "world" coordinates in [0,1]^2, exactly what MapLibre's
 * projectTile() expects) is projected by MapLibre's own projection code, so globe and mercator both work. The
 * fragment shader recovers lon/lat from the interpolated mercator position and samples the 16-bit data itself.
 */

/** Vertex shader: `prelude` and `define` come from MapLibre's `args.shaderData` (projection variant). */
export function vertexSource(prelude: string, define: string): string {
  return `#version 300 es
precision highp float;
precision highp int;
${prelude}
${define}
in vec2 a_merc;
uniform float u_x_off;   // world copy offset (mercator only)
out vec2 v_merc;
void main() {
  v_merc = a_merc;
  gl_Position = projectTile(a_merc + vec2(u_x_off, 0.0));
}`;
}

/**
 * Fragment shader. The data texture is RGBA8 with NEAREST filtering: hardware bilinear would interpolate the hi and
 * lo byte channels separately, which is wrong whenever the lo byte wraps (e.g. 0x01FF -> 0x0200 would blend through
 * 0x0100-ish garbage). So the code `R*256+G` is rebuilt per texel with texelFetch and the 4 reconstructed
 * physical values are interpolated manually. Exactly mirrors decode.ts `sampleScalar`.
 */
export const FRAGMENT = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
const float PI = 3.141592653589793;
uniform sampler2D u_a;
uniform sampler2D u_b;
uniform sampler2D u_ramp;
uniform float u_mix;
uniform float u_has_b;
uniform vec2 u_range;     // physical min,max of the encoding
uniform float u_sqrt;     // 1: sqrt-encoded
uniform float u_enc_range;// 1: range bounds sqrt(x) instead of x
uniform vec2 u_vrange;    // physical range the ramp LUT spans
uniform vec4 u_grid;      // lon_left, lat_top, dlon, dlat
uniform vec2 u_size;
uniform float u_global;
uniform float u_clip;     // 1: discard outside the mercator world (y in [0,1])
uniform float u_opacity;
in vec2 v_merc;
out vec4 fragColor;

float decode(sampler2D t, ivec2 p) {
  vec4 c = floor(texelFetch(t, p, 0) * 255.0 + 0.5);
  float code = (c.r * 256.0 + c.g) / 65535.0;
  if (u_sqrt > 0.5) {
    vec2 r = u_enc_range > 0.5 ? u_range : sqrt(max(u_range, 0.0));
    float s = mix(r.x, r.y, code);
    return s * s;
  }
  return mix(u_range.x, u_range.y, code);
}

// returns -1e30 outside a regional grid
float field(sampler2D t, float fx, float fy) {
  int w = int(u_size.x);
  int h = int(u_size.y);
  fy = clamp(fy, 0.0, float(h - 1));
  int x0; int x1; float tx;
  if (u_global > 0.5) {
    fx = fx - u_size.x * floor(fx / u_size.x);
    x0 = int(floor(fx)) % w;
    x1 = (x0 + 1) % w;
    tx = fx - floor(fx);
  } else {
    if (fx < -1e-4 || fx > float(w - 1) + 1e-4) return -1e30;
    fx = clamp(fx, 0.0, float(w - 1));
    x0 = min(int(floor(fx)), max(w - 2, 0));
    x1 = min(x0 + 1, w - 1);
    tx = fx - float(x0);
  }
  int y0 = min(int(floor(fy)), max(h - 2, 0));
  int y1 = min(y0 + 1, h - 1);
  float ty = fy - float(y0);
  float top = mix(decode(t, ivec2(x0, y0)), decode(t, ivec2(x1, y0)), tx);
  float bot = mix(decode(t, ivec2(x0, y1)), decode(t, ivec2(x1, y1)), tx);
  return mix(top, bot, ty);
}

void main() {
  if (u_clip > 0.5 && (v_merc.y < 0.0 || v_merc.y > 1.0)) discard;
  float lon = v_merc.x * 360.0 - 180.0;
  float lat = degrees(atan(sinh(PI * (1.0 - 2.0 * v_merc.y))));
  float fx = (lon - u_grid.x) / u_grid.z;
  float fy = (u_grid.y - lat) / u_grid.w;
  if (fy < -1e-4 || fy > u_size.y - 1.0 + 1e-4) discard;
  float v = field(u_a, fx, fy);
  if (v < -1e29) discard;
  if (u_has_b > 0.5 && u_mix > 0.0) {
    float vb = field(u_b, fx, fy);
    v = mix(v, vb, u_mix);
  }
  float t;
  if (u_sqrt > 0.5) {
    vec2 r = sqrt(max(u_vrange, 0.0));
    t = (sqrt(max(v, 0.0)) - r.x) / (r.y - r.x);
  } else {
    t = (v - u_vrange.x) / (u_vrange.y - u_vrange.x);
  }
  t = clamp(t, 0.0, 1.0);
  float size = 512.0;
  vec4 c = texture(u_ramp, vec2(t * (1.0 - 1.0 / size) + 0.5 / size, 0.5));
  float a = c.a * u_opacity;
  fragColor = vec4(c.rgb * a, a);
}`;

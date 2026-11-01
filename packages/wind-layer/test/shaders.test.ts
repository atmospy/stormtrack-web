import { describe, expect, it } from 'vitest';
import { COMPOSITE_FRAGMENT, DRAW_FRAGMENT, FADE_FRAGMENT, FULLSCREEN_VS, drawVertexSource, updateFragmentSource } from '../src/shaders.js';

// These only check structure; actual compilation/behaviour needs a GPU (see README "Verification").
describe('shader sources', () => {
  const all = {
    fs: FULLSCREEN_VS,
    upd: updateFragmentSource(false),
    upd8: updateFragmentSource(true),
    draw: drawVertexSource('const float PI=3.14;uniform mat4 u_projection_matrix;vec4 projectTile(vec2 p){return u_projection_matrix*vec4(p,0,1);}', '', false),
    drawF: DRAW_FRAGMENT,
    fade: FADE_FRAGMENT,
    comp: COMPOSITE_FRAGMENT,
  };
  it('are all GLSL ES 3.00 with precision statements', () => {
    for (const [k, s] of Object.entries(all)) {
      expect(s.startsWith('#version 300 es'), k).toBe(true);
      expect(s, k).toMatch(/precision highp float/);
    }
  });
  it('have balanced braces/parens', () => {
    for (const [k, s] of Object.entries(all)) {
      expect((s.match(/{/g) ?? []).length, k).toBe((s.match(/}/g) ?? []).length);
      expect((s.match(/\(/g) ?? []).length, k).toBe((s.match(/\)/g) ?? []).length);
    }
  });
  it('packed variant defines PACK8 only when requested', () => {
    expect(all.upd).not.toMatch(/#define PACK8/);
    expect(all.upd8).toMatch(/#define PACK8/);
  });
  it('draw shader uses MapLibre projectTile and the user prelude comes before main', () => {
    expect(all.draw).toMatch(/projectTile\(cur\)/);
    expect(all.draw.indexOf('u_projection_matrix')).toBeLessThan(all.draw.indexOf('void main'));
  });
  it('update shader samples both wind frames and wraps x', () => {
    expect(all.upd).toMatch(/u_wind_a/);
    expect(all.upd).toMatch(/u_wind_b/);
    expect(all.upd).toMatch(/fract\(np\.x\)/);
  });
  it('fade shader removes 8-bit residue', () => expect(all.fade).toMatch(/1\.5 \/ 255\.0/));
});

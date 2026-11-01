import { expect, it } from 'vitest';
// resolves through package.json "exports" (self-reference), as a workspace consumer would
import * as pkg from '@stormtrack/wind-layer';
it('public entry exports the documented API', () => {
  for (const k of ['WindLayer', 'decodeWindImage', 'DEFAULT_COLOR_RAMP', 'sampleWind', 'buildColorRamp']) expect(k in pkg, k).toBe(true);
  const l = new pkg.WindLayer({ id: 'x' });
  expect(l.id).toBe('x');
  expect(l.type).toBe('custom');
  expect(l.sample(0, 0)).toBeNull();
});

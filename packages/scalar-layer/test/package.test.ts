import { expect, it } from 'vitest';
// resolves through package.json "exports" (self-reference), as a workspace consumer would
import * as pkg from '@stormtrack/scalar-layer';
it('public entry exports the documented API', () => {
  for (const k of ['ScalarLayer', 'buildIsobars', 'buildIsobarSet', 'decodeScalarImage', 'SCALAR_RAMPS', 'createIsobarWorker', 'sampleScalar']) expect(k in pkg, k).toBe(true);
  for (const r of ['temperature', 'pressure', 'precipitation', 'viridis']) expect(r in pkg.SCALAR_RAMPS, r).toBe(true);
  const l = new pkg.ScalarLayer({ id: 'x', ramp: pkg.SCALAR_RAMPS.temperature, opacity: 0.75 });
  expect(l.id).toBe('x');
  expect(l.type).toBe('custom');
  expect(l.sample(0, 0)).toBeNull();
});
it('layer.sample works from a frame without GL (CPU path)', () => {
  const meta = { grid: { width: 4, height: 2, lon_left: -180, lon_right: 90, lat_top: 90, lat_bottom: -90 }, range: [0, 65535] as [number, number] };
  const data = new Uint8ClampedArray(4 * 2 * 4);
  for (let i = 0; i < 8; i++) {
    data[i * 4] = i; // code = i*256
    data[i * 4 + 3] = 255;
  }
  const l = new pkg.ScalarLayer();
  l.setFrame(meta, { data, width: 4, height: 2 } as unknown as ImageData);
  expect(l.sample(-180, 90)).toBeCloseTo(0, 3);
  expect(l.sample(0, 90)).toBeCloseTo(2 * 256, 3);
  expect(l.sample(-90, -90)).toBeCloseTo(5 * 256, 3);
});

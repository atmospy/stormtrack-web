import { describe, expect, it } from 'vitest';
import { cloudTime, cloudTileUrl } from './clouds';

const NOW = Date.parse('2026-11-02T18:52:00Z');

describe('cloudTime', () => {
  it('snaps to 10 minutes and stays behind real time', () => {
    expect(cloudTime(null, NOW)).toBe('2026-11-02T18:10:00Z');
    expect(cloudTime(Date.parse('2026-11-02T12:34:56Z'), NOW)).toBe('2026-11-02T12:30:00Z');
  });
  it('a forecast time shows the newest scan', () => {
    expect(cloudTime(Date.parse('2026-11-04T00:00:00Z'), NOW)).toBe('2026-11-02T18:10:00Z');
  });
  it('a time older than the archive shows the oldest kept scan', () => {
    expect(cloudTime(Date.parse('2026-10-01T00:00:00Z'), NOW)).toBe('2026-11-01T20:50:00Z');
  });
});
describe('cloudTileUrl', () => {
  it('uses the WMTS REST pattern with row before column', () => {
    expect(cloudTileUrl('X', '2026-11-02T18:10:00Z')).toBe('https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/X/default/2026-11-02T18:10:00Z/GoogleMapsCompatible_Level6/{z}/{y}/{x}.png');
  });
});

import { describe, expect, it } from 'vitest';
import { SondeBook, parseSonde, sondeGeoJSON } from './parse';

const pkt = (o: Record<string, unknown> = {}) => ({ serial: 'Y1', datetime: '2026-11-02T19:38:21.998Z', lat: 4.7, lon: -73.9, alt: 4069, type: 'RS41', vel_v: -19, temp: 4.9, humidity: 86, uploader_callsign: 'HKMQT', ...o });

describe('parseSonde', () => {
  it('reads a packet', () => {
    const f = parseSonde(pkt())!;
    expect(f.serial).toBe('Y1');
    expect(f.lat).toBe(4.7);
    expect(f.velV).toBe(-19);
    expect(f.t).toBe(Date.parse('2026-11-02T19:38:21.998Z'));
  });
  it('rejects missing or impossible positions', () => {
    expect(parseSonde(pkt({ lat: null }))).toBeNull();
    expect(parseSonde(pkt({ lat: 0, lon: 0 }))).toBeNull();
    expect(parseSonde(pkt({ lat: 95 }))).toBeNull();
    expect(parseSonde(pkt({ alt: 90000 }))).toBeNull();
    expect(parseSonde(pkt({ datetime: 'x' }))).toBeNull();
    expect(parseSonde(pkt({ serial: '' }))).toBeNull();
    expect(parseSonde(null)).toBeNull();
  });
});

describe('SondeBook', () => {
  it('keeps the newest fix, ignores older ones, caps the trail', () => {
    const b = new SondeBook(3);
    for (let i = 0; i < 5; i++) b.add(parseSonde(pkt({ datetime: `2026-11-02T19:00:0${i}Z`, lon: i }))!);
    b.add(parseSonde(pkt({ datetime: '2026-11-02T18:00:00Z', lon: 99 }))!);
    expect(b.last.get('Y1')!.lon).toBe(4);
    expect(b.trail.get('Y1')!.map((p) => p[0])).toEqual([2, 3, 4]);
  });
  it('prunes sondes not heard for the max age', () => {
    const b = new SondeBook();
    b.add(parseSonde(pkt())!);
    b.prune(Date.parse('2026-11-02T19:40:00Z'));
    expect(b.last.size).toBe(1);
    b.prune(Date.parse('2026-11-02T23:00:00Z'));
    expect(b.last.size).toBe(0);
    expect(b.trail.size).toBe(0);
  });
  it('builds a point per sonde and a line once there are two fixes', () => {
    const b = new SondeBook();
    b.add(parseSonde(pkt())!);
    expect(sondeGeoJSON(b, Date.now()).lines.features).toHaveLength(0);
    b.add(parseSonde(pkt({ datetime: '2026-11-02T19:38:25Z', lon: -73.8 }))!);
    const g = sondeGeoJSON(b, Date.parse('2026-11-02T19:39:00Z'));
    expect(g.points.features).toHaveLength(1);
    expect(g.lines.features).toHaveLength(1);
    expect(g.points.features[0]!.properties!.falling).toBe(true);
  });
});

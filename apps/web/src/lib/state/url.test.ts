import { describe, expect, it } from 'vitest';
import { formatTime, parse, parseTime, serialize, type ShareState } from './url';

const full: ShareState = {
  lat: 18.123456, lon: 80.5, zoom: 3.2468, model: 'ecmwf-ifs', variable: 'pressure', level: '850', t: Date.UTC(2026, 10, 1, 12), overlay: true,
  layers: ['wind', 'storms', 'lightning'], selection: { type: 'active', id: 'IO042026' }, lightningWindow: 15, pin: { lat: 19.1, lon: 72.8 },
  basins: ['NI', 'WP'], years: [1990, 2020], minCategory: 3
};

describe('share-state URL', () => {
  it('round-trips a full state (with sane rounding)', () => {
    const q = serialize(full);
    expect(q).toContain('c=18.123,80.5,3.25');
    expect(q).toContain('t=20261101T12');
    const back = parse('?' + q);
    expect(back).toEqual({ ...full, lat: 18.123, zoom: 3.25 });
  });
  it('is stable: serialize(parse(serialize(x))) === serialize(x)', () => {
    const q = serialize(full);
    expect(serialize(parse(q))).toBe(q);
  });
  it('omits everything that is not set; an empty state is an empty string', () => {
    expect(serialize({})).toBe('');
    expect(serialize({ layers: [] })).toBe('on=-');
    expect(parse('on=-').layers).toEqual([]);
    expect(parse('').layers).toBeUndefined();
  });
  it('accepts a leading ? or #', () => {
    expect(parse('#m=gfs').model).toBe('gfs');
    expect(parse('?m=gfs').model).toBe('gfs');
  });
  it('ignores garbage instead of throwing, never trusting the URL', () => {
    const s = parse('c=abc,1,2&m=<script>&f=lava&l=../../x&t=yesterday&on=wind,evil,storms&s=a:../../etc&lw=7&pin=99,500&hb=ni,NI,XXX&hy=2020-1990&hc=9');
    expect(s).toEqual({ layers: ['wind', 'storms'], basins: ['NI'] });
  });
  it('clamps and wraps the camera', () => {
    expect(parse('c=95,10,3')).toEqual({});
    expect(parse('c=10,190,30')).toMatchObject({ lon: -170, zoom: 22 });
    expect(parse('c=10,-540,1').lon).toBe(-180);
  });
  it('time format round-trips on the hour and with minutes', () => {
    const ms = Date.UTC(2026, 10, 1, 6);
    expect(formatTime(ms)).toBe('20261101T06');
    expect(parseTime('20261101T06')).toBe(ms);
    expect(parseTime('20261101T0630')).toBe(ms + 30 * 60000);
    expect(parseTime('2026-11-01')).toBeUndefined();
  });
  it('selection ids keep dots and dashes; history selections use h:', () => {
    const q = serialize({ selection: { type: 'history', id: '2019-FANI' } });
    expect(q).toBe('s=h:2019-FANI');
    expect(parse(q).selection).toEqual({ type: 'history', id: '2019-FANI' });
  });
});

describe('reduce-flashing share state', () => {
  it('round-trips rf=1 and is absent otherwise; sound is never serialised', () => {
    expect(serialize({ reduceFlashing: true })).toBe('rf=1');
    expect(parse('rf=1').reduceFlashing).toBe(true);
    expect(parse('rf=0').reduceFlashing).toBeUndefined();
    expect(serialize({ reduceFlashing: false, lightningWindow: 5 })).toBe('lw=5');
    expect(serialize({ ...({ sound: true } as object) })).toBe('');
  });
});

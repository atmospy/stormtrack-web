import { describe, expect, it } from 'vitest';
import { AUDIBLE_KM, TokenBucket, distanceToCutoff, distanceToDelay, distanceToGain, distanceToMix, energyToGain, eastOffsetKm, haversineKm, panFromOffset, selectForBurst, thunderParams, voiceToSteal, volumeToGain } from './audio';

describe('audio mapping (pure)', () => {
  it('gain falls monotonically with distance, 1 at the listener, 0 beyond the audible range', () => {
    let prev = 2;
    for (const km of [0, 1, 5, 15, 40, 100, 250, 450, 499]) {
      const g = distanceToGain(km);
      expect(g).toBeLessThanOrEqual(prev);
      prev = g;
    }
    expect(distanceToGain(0)).toBe(1);
    expect(distanceToGain(AUDIBLE_KM + 1)).toBe(0);
    expect(distanceToGain(NaN)).toBe(0);
    expect(distanceToGain(-5)).toBe(0);
  });
  it('cutoff is bright near and dull far, monotone', () => {
    expect(distanceToCutoff(0)).toBeGreaterThan(8000);
    expect(distanceToCutoff(400)).toBeLessThan(700);
    expect(distanceToCutoff(10)).toBeGreaterThan(distanceToCutoff(100));
  });
  it('delay is 1 s per 10 km capped at 6 s', () => {
    expect(distanceToDelay(0)).toBe(0);
    expect(distanceToDelay(25)).toBeCloseTo(2.5);
    expect(distanceToDelay(300)).toBe(6);
  });
  it('mix: near = crack, far = rumble only', () => {
    expect(distanceToMix(0).crack).toBe(1);
    expect(distanceToMix(80).crack).toBe(0);
    expect(distanceToMix(80).rumble).toBe(1);
  });
  it('energy scales loudness; null gets a default; clamped', () => {
    expect(energyToGain(null)).toBeCloseTo(0.55);
    expect(energyToGain(undefined)).toBeCloseTo(0.55);
    expect(energyToGain(1)).toBeCloseTo(0.35);
    expect(energyToGain(1e9)).toBe(1);
    expect(energyToGain(500)).toBeGreaterThan(energyToGain(20));
  });
  it('thunderParams combines distance and energy', () => {
    const near = thunderParams(2, 300), far = thunderParams(150, 300);
    expect(near.gain).toBeGreaterThan(far.gain);
    expect(near.delay).toBeLessThan(far.delay);
    expect(near.cutoff).toBeGreaterThan(far.cutoff);
  });
  it('pan, volume, geometry', () => {
    expect(panFromOffset(50, 100)).toBeCloseTo(0.4);
    expect(panFromOffset(-500, 100)).toBeCloseTo(-0.8);
    expect(panFromOffset(5, 0)).toBe(0);
    expect(volumeToGain(0.5)).toBeCloseTo(0.25);
    expect(volumeToGain(9)).toBe(1);
    expect(haversineKm(0, 0, 0, 1)).toBeCloseTo(111.2, 0);
    expect(eastOffsetKm(0, 179.5, 0, -179.5)).toBeGreaterThan(0); // wraps the antimeridian eastwards
  });
  it('burst selection prefers the loudest, never the silent', () => {
    expect(selectForBurst([0.1, 0.9, 0, 0.5, 0.9], 3)).toEqual([1, 4, 3]);
    expect(selectForBurst([0.5], 0)).toEqual([]);
  });
  it('voice stealing drops the quietest, or refuses a quieter candidate', () => {
    expect(voiceToSteal([0.5, 0.2, 0.9], 0.3, 3)).toBe(1);
    expect(voiceToSteal([0.5, 0.2, 0.9], 0.1, 3)).toBe(-1);
    expect(voiceToSteal([0.5], 0.1, 3)).toBe(-2);
  });
  it('token bucket caps strikes per second and refills', () => {
    let t = 0;
    const b = new TokenBucket(6, 3, () => t);
    expect(b.available()).toBe(3);
    b.take(3);
    expect(b.available()).toBe(0);
    t = 500;
    expect(b.available()).toBe(3);
    t = 10_000;
    expect(b.available()).toBe(3); // burst cap
  });
});

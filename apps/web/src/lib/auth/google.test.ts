import { describe, expect, it } from 'vitest';
import { randomNonce, sha256Hex } from './google';

describe('google sign-in helpers', () => {
  it('hashes with SHA-256 (known vector)', async () => {
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
  it('makes a fresh 128-bit hex nonce every time', () => {
    const a = randomNonce();
    const b = randomNonce();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
  });
});

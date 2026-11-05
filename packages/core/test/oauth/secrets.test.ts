import { describe, expect, it } from 'vitest';
import {
  formatUserCode,
  generateUserCode,
  isS256Challenge,
  normalizeUserCode,
  s256,
  timingSafeEqual,
  verifyPkce,
} from '../../src/oauth/secrets.ts';

describe('PKCE', () => {
  it('computes S256 as in RFC 7636 appendix B', async () => {
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const challenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
    expect(await s256(verifier)).toBe(challenge);
    expect(isS256Challenge(challenge)).toBe(true);
    expect(await verifyPkce(verifier, challenge)).toBe(true);
    expect(await verifyPkce(`${verifier}x`, challenge)).toBe(false);
  });

  it('refuses malformed verifiers even if they hash right', async () => {
    const short = 'abc';
    expect(await verifyPkce(short, await s256(short))).toBe(false);
    const bad = `${'a'.repeat(42)}!`;
    expect(await verifyPkce(bad, await s256(bad))).toBe(false);
    // A plain-method client sends the verifier itself as the challenge.
    const verifier = 'a'.repeat(43);
    expect(await verifyPkce(verifier, verifier)).toBe(false);
  });
});

describe('timingSafeEqual', () => {
  it('compares strings', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
    expect(timingSafeEqual('abc', 'abcd')).toBe(false);
    expect(timingSafeEqual('', '')).toBe(true);
  });
});

describe('user codes', () => {
  it('are 8 Crockford base32 characters', () => {
    for (let i = 0; i < 200; i++) {
      const code = generateUserCode();
      expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
      expect(normalizeUserCode(formatUserCode(code))).toBe(code);
    }
  });

  it('read the way people type them', () => {
    expect(normalizeUserCode('abcd-efgh')).toBe('ABCDEFGH');
    expect(normalizeUserCode(' ab cd ef gh ')).toBe('ABCDEFGH');
    expect(normalizeUserCode('OIL0-1234')).toBe('0110' + '1234');
    expect(normalizeUserCode('ABCD-EFG')).toBeUndefined();
    expect(normalizeUserCode('ABCD-EFGU')).toBeUndefined();
  });
});

import { describe, expect, it } from 'vitest';
import {
  CROCKFORD_ALPHABET,
  formatPairingCode,
  generatePairingCode,
  normalizePairingCode,
  PAIRING_CODE_LENGTH,
} from '../src/index.ts';

describe('typed pairing codes', () => {
  it('generates 8 Crockford base32 characters', () => {
    for (let i = 0; i < 200; i++) {
      const code = generatePairingCode();
      expect(code).toHaveLength(PAIRING_CODE_LENGTH);
      expect(normalizePairingCode(code)).toBe(code);
    }
  });

  it('maps each random byte to one character by its low 5 bits', () => {
    const bytes = Uint8Array.from([0, 1, 31, 32, 63, 200, 255, 10]);
    expect(generatePairingCode(() => bytes.slice())).toBe('01Z0Z8ZA');
    expect(CROCKFORD_ALPHABET).toHaveLength(32);
    expect(CROCKFORD_ALPHABET).not.toMatch(/[ILOU]/);
    expect(() => generatePairingCode(() => new Uint8Array(7))).toThrow();
  });

  it('normalizes what a user types', () => {
    expect(normalizePairingCode('abcd-efgh')).toBe('ABCDEFGH');
    expect(normalizePairingCode(' abcd efgh ')).toBe('ABCDEFGH');
    expect(normalizePairingCode('iLoO-1100')).toBe('11001100');
    expect(normalizePairingCode('ABCDEFGU')).toBeUndefined();
    expect(normalizePairingCode('ABCDEFG')).toBeUndefined();
    expect(normalizePairingCode('ABCDEFGHJ')).toBeUndefined();
    expect(normalizePairingCode('ABCD_EFG')).toBeUndefined();
    expect(normalizePairingCode(`${'-'.repeat(40)}ABCDEFGH`)).toBeUndefined();
    expect(normalizePairingCode(12345678)).toBeUndefined();
  });

  it('formats a code in two groups', () => {
    expect(formatPairingCode('ABCDEFGH')).toBe('ABCD-EFGH');
  });
});

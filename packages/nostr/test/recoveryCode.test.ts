import { hexToBytes } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';
import {
  decodeNcryptsec,
  encodeNcryptsec,
  formatRecoveryBase32,
  generateRecoveryCode,
  parseRecoveryCode,
  RECOVERY_CODE_BASE32_LENGTH,
  recoveryCodeToBase32,
  recoveryCodeToWords,
  recoveryPassword,
} from '../src/index.ts';
import { queueKey } from './helpers.ts';

// BIP-39's own English test vectors (trezor/python-mnemonic vectors.json), 128-bit entropy.
const VECTORS: [string, string][] = [
  [
    '00000000000000000000000000000000',
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
  ],
  [
    '7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f',
    'legal winner thank year wave sausage worth useful legal winner thank yellow',
  ],
  [
    '80808080808080808080808080808080',
    'letter advice cage absurd amount doctor acoustic avoid letter advice cage above',
  ],
  ['ffffffffffffffffffffffffffffffff', 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong'],
];

describe('recovery code', () => {
  it('generates 16 bytes', () => {
    expect(generateRecoveryCode()).toHaveLength(16);
    expect(() => generateRecoveryCode(() => new Uint8Array(8))).toThrow();
  });

  it.each(VECTORS)('encodes %s as the BIP-39 vector', (hex, mnemonic) => {
    const bytes = hexToBytes(hex);
    expect(recoveryCodeToWords(bytes).join(' ')).toBe(mnemonic);
    expect(parseRecoveryCode(mnemonic)).toEqual(bytes);
  });

  it('round trips random codes through words and base32', () => {
    for (let i = 0; i < 200; i++) {
      const bytes = generateRecoveryCode();
      const words = recoveryCodeToWords(bytes);
      expect(words).toHaveLength(12);
      expect(parseRecoveryCode(words.join(' '))).toEqual(bytes);
      const base32 = recoveryCodeToBase32(bytes);
      expect(base32).toHaveLength(RECOVERY_CODE_BASE32_LENGTH);
      expect(parseRecoveryCode(base32)).toEqual(bytes);
      expect(parseRecoveryCode(formatRecoveryBase32(base32).toLowerCase())).toEqual(bytes);
    }
  });

  it('encodes base32 with Crockford digits and two zero pad bits', () => {
    expect(recoveryCodeToBase32(new Uint8Array(16))).toBe('0'.repeat(26));
    expect(recoveryCodeToBase32(new Uint8Array(16).fill(0xff))).toBe(`${'Z'.repeat(25)}W`);
    expect(formatRecoveryBase32('0'.repeat(26))).toBe('0000-0000-0000-0000-0000-0000-00');
  });

  it('reads Crockford look-alikes and ignores case, spaces and hyphens', () => {
    const bytes = new Uint8Array(16);
    expect(parseRecoveryCode('oooo-oooo oooo-oooo-oooo-oooo-oo')).toEqual(bytes);
    const ones = recoveryCodeToBase32(hexToBytes('08421084210842108421084210842108'));
    expect(parseRecoveryCode(ones.replace(/1/g, 'l'))).toEqual(parseRecoveryCode(ones));
  });

  it('accepts words in any case with extra whitespace and commas', () => {
    const [hex, mnemonic] = VECTORS[1] as [string, string];
    expect(parseRecoveryCode(`  ${mnemonic.toUpperCase().replace(/ /g, ',  ')} `)).toEqual(
      hexToBytes(hex)
    );
  });

  it('refuses a bad checksum, an unknown word, the wrong count and junk', () => {
    const words = (VECTORS[1] as [string, string])[1].split(' ');
    const badChecksum = [...words.slice(0, 11), 'zoo'].join(' ');
    expect(parseRecoveryCode(badChecksum)).toBeUndefined();
    expect(parseRecoveryCode([...words.slice(0, 11), 'qusme'].join(' '))).toBeUndefined();
    expect(parseRecoveryCode(words.slice(0, 11).join(' '))).toBeUndefined();
    expect(parseRecoveryCode(`${'Z'.repeat(25)}Z`)).toBeUndefined(); // pad bits not zero
    expect(parseRecoveryCode('U'.repeat(26))).toBeUndefined();
    expect(parseRecoveryCode('0'.repeat(25))).toBeUndefined();
    expect(parseRecoveryCode(42)).toBeUndefined();
    expect(parseRecoveryCode('')).toBeUndefined();
  });

  it('uses the 32-character lowercase hex as the NIP-49 password', () => {
    const bytes = hexToBytes('00ff00ff00ff00ff00ff00ff00ff00ff');
    expect(recoveryPassword(bytes)).toBe('00ff00ff00ff00ff00ff00ff00ff00ff');
    const ncryptsec = encodeNcryptsec(queueKey, recoveryPassword(bytes), { logN: 16 });
    const typed = parseRecoveryCode(recoveryCodeToWords(bytes).join(' ')) as Uint8Array;
    expect(decodeNcryptsec(ncryptsec, recoveryPassword(typed))).toEqual(queueKey);
  });
});

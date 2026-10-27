import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { bech32 } from '@scure/base';
import { describe, expect, it } from 'vitest';
import {
  decodeNcryptsec,
  encodeNcryptsec,
  NCRYPTSEC_DEFAULT_LOG_N,
  ncryptsecParams,
} from '../src/index.ts';

// The decryption example in the NIP-49 text.
const NIP49_NCRYPTSEC =
  'ncryptsec1qgg9947rlpvqu76pj5ecreduf9jxhselq2nae2kghhvd5g7dgjtcxfqtd67p9m0w57lspw8gsq6yphnm8623nsl8xn9j4jdzz84zm3frztj3z7s35vpzmqf6ksu8r89qk5z2zxfmu5gv8th8wclt0h4p';
const NIP49_KEY = '3501454135014541350145413501453fefb02227e449e57cf4d3a3ce05378683';

const key = hexToBytes('7f7ff03d123792d6ac594bfa67bf6d0c0ab55b6b1fdb6249303fe861f1ccba9a');

describe('NIP-49', () => {
  it('decodes the NIP-49 test vector', () => {
    expect(ncryptsecParams(NIP49_NCRYPTSEC).logN).toBe(16);
    expect(bytesToHex(decodeNcryptsec(NIP49_NCRYPTSEC, 'nostr'))).toBe(NIP49_KEY);
  });

  it('refuses the wrong passphrase', () => {
    expect(() => decodeNcryptsec(NIP49_NCRYPTSEC, 'nostR')).toThrow();
  });

  it('round-trips at the default log_n of 18', () => {
    expect(NCRYPTSEC_DEFAULT_LOG_N).toBe(18);
    const ncryptsec = encodeNcryptsec(key, 'correct horse battery staple');
    expect(ncryptsec.startsWith('ncryptsec1')).toBe(true);
    expect(ncryptsecParams(ncryptsec)).toEqual({ logN: 18, keySecurity: 0x02 });
    expect(bytesToHex(decodeNcryptsec(ncryptsec, 'correct horse battery staple'))).toBe(
      bytesToHex(key)
    );
    // Two scrypt runs at log_n 18 take about 2.5 s each on the runners, over vitest's 5 s default.
  }, 30_000);

  it('takes log_n and the key security byte per call', () => {
    const ncryptsec = encodeNcryptsec(key, 'pw', { logN: 16, keySecurity: 0x01 });
    expect(ncryptsecParams(ncryptsec)).toEqual({ logN: 16, keySecurity: 0x01 });
    expect(decodeNcryptsec(ncryptsec, 'pw')).toEqual(key);
  });

  it('normalizes the passphrase to NFKC', () => {
    // NIP-49's normalization example: U+212B U+2126 U+1E9B U+0323 becomes U+00C5 U+03A9 U+1E69.
    const ncryptsec = encodeNcryptsec(key, 'ÅΩẛ̣', { logN: 16 });
    expect(decodeNcryptsec(ncryptsec, 'ÅΩṩ')).toEqual(key);
  });

  it('refuses a log_n outside 16 to 20 when encrypting', () => {
    expect(() => encodeNcryptsec(key, 'pw', { logN: 15 })).toThrow(/too weak/);
    expect(() => encodeNcryptsec(key, 'pw', { logN: 21 })).toThrow();
    expect(() => encodeNcryptsec(key, 'pw', { logN: 16.5 })).toThrow();
  });

  it('refuses an ncryptsec asking for more than 1 GiB of scrypt memory', () => {
    // The NIP-49 vector with its log_n byte raised to 21 and the checksum recomputed.
    const ncryptsec = withLogN(NIP49_NCRYPTSEC, 21);
    expect(ncryptsecParams(ncryptsec).logN).toBe(21);
    expect(() => decodeNcryptsec(ncryptsec, 'nostr')).toThrow(/log_n/);
  });

  it('refuses something that is not an ncryptsec', () => {
    expect(() =>
      ncryptsecParams('npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqsx5l3ex')
    ).toThrow();
    expect(() => decodeNcryptsec('ncryptsec1notbech32', 'pw')).toThrow();
  });

  it('refuses a secret key of the wrong length', () => {
    expect(() => encodeNcryptsec(new Uint8Array(31), 'pw', { logN: 16 })).toThrow();
  });
});

function withLogN(ncryptsec: string, logN: number): string {
  const { prefix, words } = bech32.decode(ncryptsec as `${string}1${string}`, 5000);
  const bytes = bech32.fromWords(words);
  bytes[1] = logN;
  return bech32.encode(prefix, bech32.toWords(bytes), 5000);
}

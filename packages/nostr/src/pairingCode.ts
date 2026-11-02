/**
 * The typed code of spec 8.3 step 2: 8 Crockford base32 characters (40 bits) that the service
 * maps to a `nostrpair://` URI for a new device without a camera. The service generates codes;
 * both the service and the devices normalize what a user typed with {@link normalizePairingCode}.
 */
import { randomBytes } from '@noble/hashes/utils.js';

/** Crockford's base32 alphabet: digits and letters without I, L, O and U. */
export const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const PAIRING_CODE_LENGTH = 8;

const CODE = /^[0-9A-HJKMNP-TV-Z]{8}$/;

/** A fresh random code. Each character takes 5 bits of one random byte, so all are uniform. */
export function generatePairingCode(random: (n: number) => Uint8Array = randomBytes): string {
  const bytes = random(PAIRING_CODE_LENGTH);
  if (bytes.length !== PAIRING_CODE_LENGTH) throw new Error('random source returned short');
  let code = '';
  for (const byte of bytes) code += CROCKFORD_ALPHABET[byte & 31];
  bytes.fill(0);
  return code;
}

/**
 * The canonical form of a code a user typed, or undefined if it isn't one: case is ignored,
 * spaces and hyphens are dropped, and Crockford's look-alikes are read as digits (I and L as 1,
 * O as 0). U is not in the alphabet and is refused.
 */
export function normalizePairingCode(input: unknown): string | undefined {
  if (typeof input !== 'string' || input.length > 32) return undefined;
  const code = input.toUpperCase().replace(/[\s-]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0');
  return CODE.test(code) ? code : undefined;
}

/** A code for display: two groups of four, `ABCD-EFGH`. */
export function formatPairingCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

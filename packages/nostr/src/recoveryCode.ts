/**
 * The recovery code of spec 6.1: 16 random bytes that encrypt the published recovery backup.
 * Shown as 12 words from the BIP-39 English list (128 bits plus a 4-bit checksum) and offered as
 * 26 Crockford base32 characters for printing (128 bits plus 2 zero bits). Devices accept either
 * form and parse it back to the 16 bytes; the NIP-49 password is the bytes' 32-character
 * lowercase hex. Devices never keep the code.
 */

import { bytesToHex, randomBytes } from '@noble/hashes/utils.js';
import { entropyToMnemonic, mnemonicToEntropy } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { CROCKFORD_ALPHABET } from './pairingCode.ts';

export const RECOVERY_CODE_BYTES = 16;
export const RECOVERY_CODE_WORDS = 12;
/** ceil(128 / 5): the last character carries 3 bits of the code and 2 zero bits. */
export const RECOVERY_CODE_BASE32_LENGTH = 26;

/** Fresh random recovery code bytes. Overwrite them once the backup is published. */
export function generateRecoveryCode(random: (n: number) => Uint8Array = randomBytes): Uint8Array {
  const bytes = random(RECOVERY_CODE_BYTES);
  if (bytes.length !== RECOVERY_CODE_BYTES) throw new Error('random source returned short');
  return bytes;
}

function checkLength(bytes: Uint8Array): void {
  if (bytes.length !== RECOVERY_CODE_BYTES) throw new Error('a recovery code is 16 bytes');
}

/** The BIP-39 English list the code's words come from (2048 words), for passphrase suggestions. */
export const RECOVERY_WORDLIST: readonly string[] = wordlist;

/** The 12 BIP-39 English words for the code, the last carrying the checksum. */
export function recoveryCodeToWords(bytes: Uint8Array): string[] {
  checkLength(bytes);
  return entropyToMnemonic(bytes, wordlist).split(' ');
}

/** The 26-character Crockford base32 form, upper case, no separators. */
export function recoveryCodeToBase32(bytes: Uint8Array): string {
  checkLength(bytes);
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += CROCKFORD_ALPHABET[(buffer >> bits) & 31];
    }
    buffer &= (1 << bits) - 1;
  }
  if (bits > 0) out += CROCKFORD_ALPHABET[(buffer << (5 - bits)) & 31];
  return out;
}

/** The base32 form for display: groups of four, `ABCD-EFGH-...-YZ`. */
export function formatRecoveryBase32(code: string): string {
  return code.match(/.{1,4}/g)?.join('-') ?? code;
}

function fromBase32(text: string): Uint8Array | undefined {
  const normalized = text
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0');
  if (normalized.length !== RECOVERY_CODE_BASE32_LENGTH) return undefined;
  const out = new Uint8Array(RECOVERY_CODE_BYTES);
  let buffer = 0;
  let bits = 0;
  let index = 0;
  for (const char of normalized) {
    const value = CROCKFORD_ALPHABET.indexOf(char);
    if (value < 0) return undefined;
    buffer = (buffer << 5) | value;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      if (index < RECOVERY_CODE_BYTES) out[index] = (buffer >> bits) & 0xff;
      index += 1;
    }
    buffer &= (1 << bits) - 1;
  }
  // 130 bits read, 128 used: the two left over must be zero, or this is not a code we wrote.
  if (index !== RECOVERY_CODE_BYTES || buffer !== 0) return undefined;
  return out;
}

function fromWords(text: string): Uint8Array | undefined {
  const words = text
    .toLowerCase()
    .trim()
    .split(/[\s,]+/)
    .filter(Boolean);
  if (words.length !== RECOVERY_CODE_WORDS) return undefined;
  try {
    // Checks every word is on the list and the checksum matches.
    return mnemonicToEntropy(words.join(' '), wordlist);
  } catch {
    return undefined;
  }
}

/**
 * The 16 bytes of a recovery code the user typed, in either form, or undefined. Words: case and
 * extra spaces or commas ignored, checksum checked. Base32: case, spaces and hyphens ignored, I
 * and L read as 1, O as 0.
 */
export function parseRecoveryCode(input: unknown): Uint8Array | undefined {
  if (typeof input !== 'string' || input.length > 512) return undefined;
  const tokens = input
    .trim()
    .split(/[\s,]+/)
    .filter(Boolean);
  return tokens.length === RECOVERY_CODE_WORDS ? fromWords(input) : fromBase32(input);
}

/** The NIP-49 password for the recovery backup: the code's bytes as 32 lowercase hex (6.1). */
export function recoveryPassword(bytes: Uint8Array): string {
  checkLength(bytes);
  return bytesToHex(bytes);
}

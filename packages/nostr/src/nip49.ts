import { bech32 } from '@scure/base';
import { decrypt, encrypt } from 'nostr-tools/nip49';

/**
 * The scrypt cost (`log_n`, N = 2^log_n) used when a caller passes none. 18 costs 256 MiB of
 * memory per unlock (128 * r * N bytes with r = 8), within the reach of current phones, where the
 * PWA unlocks (spec 6.1, 12). Each step up doubles the time and memory of an unlock, and of every
 * offline passphrase guess against the recovery backup. The spec sets 18 for the queue key
 * (section 6.1, decided 2026-10-27 in section 17).
 */
export const NCRYPTSEC_DEFAULT_LOG_N = 18;
/** The lowest `log_n` accepted when encrypting: NIP-49's smallest example, 64 MiB. */
export const NCRYPTSEC_MIN_LOG_N = 16;
/**
 * The highest `log_n` accepted when encrypting or decrypting: 1 GiB, the most `@noble/hashes`'
 * scrypt allows by default. Checked before scrypt runs, so a crafted `ncryptsec` can't ask for
 * more memory than that.
 */
export const NCRYPTSEC_MAX_LOG_N = 20;

/**
 * NIP-49's key security byte: 0x00 the key has been handled insecurely (stored unencrypted, copied
 * around), 0x01 it has not, 0x02 the client does not track this.
 */
export type KeySecurity = 0x00 | 0x01 | 0x02;

export interface NcryptsecOptions {
  /** scrypt cost; defaults to {@link NCRYPTSEC_DEFAULT_LOG_N}. */
  logN?: number;
  /** Defaults to 0x02 (not tracked). */
  keySecurity?: KeySecurity;
}

export interface NcryptsecParams {
  logN: number;
  keySecurity: KeySecurity;
}

// version, log_n, 16-byte salt, 24-byte nonce, key security byte, 32-byte key + 16-byte tag
const NCRYPTSEC_BYTES = 1 + 1 + 16 + 24 + 1 + 48;
const BECH32_LIMIT = 5000;

function checkLogN(logN: number): void {
  if (!Number.isInteger(logN) || logN < 1 || logN > NCRYPTSEC_MAX_LOG_N) {
    throw new Error(`ncryptsec log_n must be an integer from 1 to ${NCRYPTSEC_MAX_LOG_N}`);
  }
}

/**
 * Encrypts a 32-byte secret key under a passphrase as a NIP-49 `ncryptsec`. The passphrase is
 * NFKC-normalized first, as NIP-49 requires. Takes about as long as one unlock at the same `logN`.
 */
export function encodeNcryptsec(
  secretKey: Uint8Array,
  passphrase: string,
  options: NcryptsecOptions = {}
): string {
  const logN = options.logN ?? NCRYPTSEC_DEFAULT_LOG_N;
  checkLogN(logN);
  if (logN < NCRYPTSEC_MIN_LOG_N) {
    throw new Error(`ncryptsec log_n below ${NCRYPTSEC_MIN_LOG_N} is too weak`);
  }
  if (secretKey.length !== 32) throw new Error('secret key must be 32 bytes');
  return encrypt(secretKey, passphrase, logN, options.keySecurity ?? 0x02);
}

/**
 * Reads the parameters of an `ncryptsec` without the passphrase, so a client can tell the user
 * how long an unlock will take, or re-encrypt at a new cost after unlocking.
 */
export function ncryptsecParams(ncryptsec: string): NcryptsecParams {
  const { prefix, words } = bech32.decode(ncryptsec as `${string}1${string}`, BECH32_LIMIT);
  if (prefix !== 'ncryptsec') throw new Error(`expected an ncryptsec, got prefix ${prefix}`);
  const bytes = bech32.fromWords(words);
  if (bytes.length !== NCRYPTSEC_BYTES) throw new Error('ncryptsec has the wrong length');
  if (bytes[0] !== 0x02) throw new Error(`unknown ncryptsec version ${bytes[0]}`);
  const logN = bytes[1] as number;
  const keySecurity = bytes[2 + 16 + 24] as number;
  if (keySecurity !== 0x00 && keySecurity !== 0x01 && keySecurity !== 0x02) {
    throw new Error(`unknown ncryptsec key security byte ${keySecurity}`);
  }
  return { logN, keySecurity };
}

/**
 * Decrypts an `ncryptsec` with a passphrase and returns the 32-byte secret key. Throws on a wrong
 * passphrase (the Poly1305 tag fails), a malformed string, or a `log_n` above
 * {@link NCRYPTSEC_MAX_LOG_N}.
 */
export function decodeNcryptsec(ncryptsec: string, passphrase: string): Uint8Array {
  checkLogN(ncryptsecParams(ncryptsec).logN);
  return decrypt(ncryptsec, passphrase);
}

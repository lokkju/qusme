/**
 * NIP-AB's `nostrpair://` URI: `nostrpair://{pubkey_hex}?secret={secret_hex}&relay={url}&v=1`,
 * with `relay` repeated for each relay. The parser follows the NIP's MUSTs and agrees with
 * block/buzz's `decode_qr` on every case in its vectors except one: it also refuses a pubkey that
 * is not on the curve, which the NIP requires and buzz does not check.
 */
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { isCurvePoint } from './nipAbCrypto.ts';
import { capture, checkInput, Invalid, type ParseResult } from './result.ts';
import { readRelayUrl } from './validate.ts';

export const NOSTRPAIR_SCHEME = 'nostrpair://';
/** The protocol version this implementation speaks, in the URI's `v` and the offer's `version`. */
export const NIP_AB_VERSION = 1;
/** NIP-AB: the whole URI MUST NOT exceed 2048 characters. */
export const NOSTRPAIR_MAX_LENGTH = 2048;
/** NIP-AB recommends one to three relays; spec 8.3 lists up to three storage relays. */
export const NOSTRPAIR_MAX_RELAYS = 3;

const HEX64 = /^[0-9a-f]{64}$/;

export interface PairingUri {
  /** The source's ephemeral pubkey, lowercase hex. */
  sourcePubkey: string;
  /** The 32-byte session secret. Overwrite it once the session ends. */
  sessionSecret: Uint8Array;
  /** Relay URLs, in the URI's order, duplicates removed. */
  relays: string[];
  version: typeof NIP_AB_VERSION;
}

function readSecret(value: string, path: string): Uint8Array {
  if (!HEX64.test(value)) throw new Invalid('invalid_content', 'expected 64 lowercase hex', path);
  const bytes = hexToBytes(value);
  if (bytes.every((b) => b === 0)) throw new Invalid('invalid_content', 'all zeros', path);
  return bytes;
}

function readRelays(relays: readonly string[], path: string): string[] {
  if (relays.length === 0) throw new Invalid('invalid_content', 'at least one relay', path);
  return [...new Set(relays.map((relay, i) => readRelayUrl(relay, `${path}[${i}]`)))];
}

/**
 * Builds the URI a source shows as a QR code. Relay URLs are percent-encoded. Throws on a pubkey
 * that is not a curve point, a secret that is not 32 non-zero bytes, no relays, more than
 * {@link NOSTRPAIR_MAX_RELAYS}, a relay that is not `wss://` or `ws://`, or a URI over 2048
 * characters.
 */
export function buildPairingUri(uri: Omit<PairingUri, 'version'>): string {
  return checkInput('nostrpair URI', () => {
    if (!isCurvePoint(uri.sourcePubkey)) {
      throw new Invalid('invalid_content', 'not a secp256k1 x-only pubkey', 'pubkey');
    }
    if (uri.sessionSecret.length !== 32) {
      throw new Invalid('invalid_content', 'expected 32 bytes', 'secret');
    }
    const secret = bytesToHex(uri.sessionSecret);
    readSecret(secret, 'secret');
    const relays = readRelays(uri.relays, 'relay');
    if (relays.length > NOSTRPAIR_MAX_RELAYS) {
      throw new Invalid('invalid_content', `more than ${NOSTRPAIR_MAX_RELAYS} relays`, 'relay');
    }
    const query = [`secret=${secret}`, ...relays.map((r) => `relay=${encodeURIComponent(r)}`)];
    const text = `${NOSTRPAIR_SCHEME}${uri.sourcePubkey}?${query.join('&')}&v=${NIP_AB_VERSION}`;
    if (text.length > NOSTRPAIR_MAX_LENGTH) {
      throw new Invalid('invalid_content', `longer than ${NOSTRPAIR_MAX_LENGTH} characters`);
    }
    return text;
  });
}

/**
 * Parses a `nostrpair://` URI from a QR code or from the service (spec 8.3 step 3). Refuses, as
 * NIP-AB requires: more than 2048 characters, another scheme, a pubkey or secret that is not 64
 * lowercase hex, a pubkey off the curve, an all-zero secret, no relay, a relay that is not
 * `wss://` or `ws://`, and any `v` other than 1. Also refuses a repeated `secret` or `v`. Unknown
 * parameters (buzz's `mode`, for one) are ignored.
 */
export function parsePairingUri(text: unknown): ParseResult<PairingUri> {
  return capture(() => {
    if (typeof text !== 'string') throw new Invalid('invalid_content', 'expected a string');
    if (text.length > NOSTRPAIR_MAX_LENGTH) {
      throw new Invalid('invalid_content', `longer than ${NOSTRPAIR_MAX_LENGTH} characters`);
    }
    if (!text.startsWith(NOSTRPAIR_SCHEME)) {
      throw new Invalid('invalid_content', `expected ${NOSTRPAIR_SCHEME}`);
    }
    const rest = text.slice(NOSTRPAIR_SCHEME.length);
    const q = rest.indexOf('?');
    if (q < 0) throw new Invalid('invalid_content', 'missing query', 'secret');
    const pubkey = rest.slice(0, q);
    if (!HEX64.test(pubkey) || !isCurvePoint(pubkey)) {
      throw new Invalid('invalid_content', 'not a secp256k1 x-only pubkey', 'pubkey');
    }
    let secret: string | undefined;
    let version: string | undefined;
    const relays: string[] = [];
    for (const pair of rest.slice(q + 1).split('&')) {
      const eq = pair.indexOf('=');
      if (eq < 0) continue;
      const key = pair.slice(0, eq);
      const raw = pair.slice(eq + 1);
      if (key === 'secret') {
        if (secret !== undefined) throw new Invalid('invalid_content', 'repeated', 'secret');
        secret = raw;
      } else if (key === 'v') {
        if (version !== undefined) throw new Invalid('invalid_content', 'repeated', 'v');
        version = raw;
      } else if (key === 'relay') {
        try {
          relays.push(decodeURIComponent(raw));
        } catch {
          throw new Invalid('invalid_content', 'bad percent-encoding', 'relay');
        }
      }
    }
    if (version !== undefined && version !== String(NIP_AB_VERSION)) {
      throw new Invalid('invalid_content', `unsupported version ${version}`, 'v');
    }
    if (secret === undefined) throw new Invalid('invalid_content', 'missing', 'secret');
    const sessionSecret = readSecret(secret, 'secret');
    return {
      sourcePubkey: pubkey,
      sessionSecret,
      relays: readRelays(relays, 'relay'),
      version: NIP_AB_VERSION,
    };
  });
}

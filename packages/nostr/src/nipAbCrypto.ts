/**
 * NIP-AB's derivations (nostr-protocol/nips#2328): session id, the unhashed ECDH x-coordinate,
 * the SAS and the transcript hash. Pure functions over byte arrays; the state machines in
 * `nipAb.ts` call them. Checked against the NIP's test vectors and block/buzz's.
 */
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';

const INFO_SESSION_ID = utf8ToBytes('nostr-pair-session-id');
const INFO_SAS = utf8ToBytes('nostr-pair-sas-v1');
const INFO_TRANSCRIPT = utf8ToBytes('nostr-pair-transcript-v1');
const EMPTY = new Uint8Array(0);

function check32(bytes: Uint8Array, what: string): void {
  if (bytes.length !== 32) throw new Error(`${what} must be 32 bytes`);
}

/** `session_id = HKDF-SHA256(IKM=session_secret, salt="", info="nostr-pair-session-id", L=32)`. */
export function deriveSessionId(sessionSecret: Uint8Array): Uint8Array {
  check32(sessionSecret, 'session secret');
  return hkdf(sha256, sessionSecret, EMPTY, INFO_SESSION_ID, 32);
}

/**
 * True for a 64-character lowercase hex x-coordinate of a point on secp256k1 (BIP-340), which
 * NIP-AB requires of every ephemeral pubkey. Zero and values at or above the field prime fail.
 */
export function isCurvePoint(pubkey: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(pubkey)) return false;
  try {
    secp256k1.Point.fromBytes(hexToBytes(`02${pubkey}`));
    return true;
  } catch {
    return false;
  }
}

/**
 * The 32-byte x-coordinate of `secretKey * pubkey`, unhashed, as NIP-AB requires. nostr-tools'
 * `getConversationKey` runs it through NIP-44's HKDF, so it can't be used here.
 */
export function ecdhShared(secretKey: Uint8Array, pubkey: string): Uint8Array {
  check32(secretKey, 'secret key');
  if (!isCurvePoint(pubkey)) throw new Error('pubkey is not a secp256k1 point');
  const point = secp256k1.getSharedSecret(secretKey, hexToBytes(`02${pubkey}`), true);
  const x = point.slice(1, 33);
  point.fill(0);
  return x;
}

export interface Sas {
  /** The six digits both screens show, zero-padded. */
  code: string;
  /** `sas_input`, which the transcript hash covers. */
  input: Uint8Array;
}

/**
 * `sas_input = HKDF-SHA256(IKM=ecdh_shared, salt=session_secret, info="nostr-pair-sas-v1", L=32)`
 * and `sas_code = be_u32(sas_input[0:4]) mod 1000000`, shown as six zero-padded digits.
 */
export function deriveSas(ecdh: Uint8Array, sessionSecret: Uint8Array): Sas {
  check32(ecdh, 'ECDH output');
  check32(sessionSecret, 'session secret');
  const input = hkdf(sha256, ecdh, sessionSecret, INFO_SAS, 32);
  const n = new DataView(input.buffer, input.byteOffset, 4).getUint32(0, false);
  return { code: String(n % 1_000_000).padStart(6, '0'), input };
}

/**
 * `transcript_hash = HKDF-SHA256(IKM=session_id || source_pubkey || target_pubkey || sas_input,
 * salt=session_secret, info="nostr-pair-transcript-v1", L=32)`.
 */
export function deriveTranscriptHash(
  sessionId: Uint8Array,
  sourcePubkey: string,
  targetPubkey: string,
  sasInput: Uint8Array,
  sessionSecret: Uint8Array
): Uint8Array {
  check32(sessionId, 'session id');
  check32(sasInput, 'SAS input');
  check32(sessionSecret, 'session secret');
  const transcript = new Uint8Array(128);
  transcript.set(sessionId, 0);
  transcript.set(hexToBytes(sourcePubkey), 32);
  transcript.set(hexToBytes(targetPubkey), 64);
  transcript.set(sasInput, 96);
  const out = hkdf(sha256, transcript, sessionSecret, INFO_TRANSCRIPT, 32);
  transcript.fill(0);
  return out;
}

/** Equality whose time depends only on the lengths, for session ids and transcript hashes. */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}

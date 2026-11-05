/**
 * NIP-AB device pairing (nostr-protocol/nips#2328) as qus.me runs it (spec 8.3): the existing
 * device is the source, the new device the target. Both roles are state machines with no
 * networking inside. The caller feeds in kind 24134 events from the relays, the user's SAS
 * decision and the clock, and publishes whatever each call returns, in order, to every relay of
 * the session (the target's offer to the first relay that connects, per NIP-AB).
 *
 * qus.me's policy on top of NIP-AB:
 * - `payload_type` is `"nsec"` and `payload` is always an `ncryptsec`: the source refuses to send
 *   anything else and the target refuses to accept anything else (8.3 steps 5 and 6).
 * - A session that issued a typed code sends the recovery backup; a QR session sends the
 *   passphrase copy (8.3 step 2). The source picks, so the choice is made in one place.
 * - The decrypted payload also carries `qusme_relays` and `qusme_npub`; a plain NIP-AB peer
 *   ignores them.
 * - The target holds a `payload` that arrives early, unread, until the transcript hash has
 *   verified and the user has confirmed the SAS on the target, then hands it to the caller and
 *   waits for {@link PairingTarget.stored} before sending `complete` (8.3 step 6).
 *
 * Secrets live in `Uint8Array`s and are overwritten when a session ends. JavaScript strings
 * (the URI, decrypted JSON, the `ncryptsec`) can't be wiped; references to them are dropped.
 */
import { bytesToHex, hexToBytes, randomBytes } from '@noble/hashes/utils.js';
import type { EventTemplate, NostrEvent } from 'nostr-tools/core';
import { decode as nip19Decode, npubEncode } from 'nostr-tools/nip19';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { KIND_PAIRING, KIND_RELAY_AUTH } from './kinds.ts';
import { nip44ConversationKey, nip44DecryptWithKey, nip44EncryptWithKey } from './nip44.ts';
import { NCRYPTSEC_MAX_LOG_N, ncryptsecParams } from './nip49.ts';
import {
  constantTimeEqual,
  deriveSas,
  deriveSessionId,
  deriveTranscriptHash,
  ecdhShared,
  isCurvePoint,
} from './nipAbCrypto.ts';
import { buildPairingUri, NIP_AB_VERSION, type PairingUri } from './nipAbUri.ts';
import { Invalid } from './result.ts';
import { isHex64, parseJsonText, readRelayUrl, readSignedEvent } from './validate.ts';

/** NIP-AB: the whole session MUST NOT exceed 120 seconds from QR display. */
export const PAIRING_SESSION_TIMEOUT_MS = 120_000;
/** NIP-AB: wait up to 30 seconds for an expected message (and for `complete`). */
export const PAIRING_STEP_TIMEOUT_MS = 30_000;
/** NIP-AB: `created_at` is jittered up to 30 seconds into the past. */
export const PAIRING_CREATED_AT_JITTER = 30;

const CONTENT_MIN = 132;
const CONTENT_MAX = 87_472;

export const ABORT_REASONS = ['sas_mismatch', 'user_denied', 'timeout', 'protocol_error'] as const;
export type AbortReason = (typeof ABORT_REASONS)[number];

/** How the target got the URI, which decides the payload and what the target asks for. */
export type PairingChannel = 'qr' | 'typed-code';
/** What the new device asks the user for to open the received `ncryptsec` (spec 8.3 step 7). */
export type UnlockSecret = 'passphrase' | 'recovery-code';

export const unlockSecretFor = (channel: PairingChannel): UnlockSecret =>
  channel === 'typed-code' ? 'recovery-code' : 'passphrase';

/** The relay filter each device subscribes with on every relay of the session. */
export function pairingFilter(ownPubkey: string): { kinds: number[]; '#p': string[] } {
  return { kinds: [KIND_PAIRING], '#p': [ownPubkey] };
}

/** What a call returns: events to publish, in order, and what the UI should hear about. */
export interface PairingStep {
  publish: NostrEvent[];
  notice?: PairingNotice;
}

export type PairingNotice =
  /** Source: an offer was accepted. Show the SAS and ask the user to compare and confirm. */
  | { type: 'sas'; sas: string }
  /** Target: the source's user confirmed and the transcript hash verified. */
  | { type: 'verified' }
  /** Target: store `payload.ncryptsec`, then call `stored()`, then prompt for the secret. */
  | { type: 'payload'; payload: ReceivedPayload }
  /** Target: the payload was not an `ncryptsec`; `complete` with `success: false` went out. */
  | { type: 'refused'; reason: 'not_ncryptsec' | 'unsupported_payload_type' }
  /** Source: the target's `complete`. */
  | { type: 'complete'; success: boolean }
  /** Source: no `complete` within 30 s. Show "Transfer sent; check your other device". */
  | { type: 'unconfirmed' }
  /** Either: the session ended early. `by: 'local'` covers timeouts and the user denying. */
  | { type: 'aborted'; reason: AbortReason; by: 'local' | 'peer' };

/** A payload the target may act on: the transcript verified and the user confirmed. */
export interface ReceivedPayload {
  ncryptsec: string;
  /** scrypt cost of the `ncryptsec`, so the UI can say how long the unlock will take. */
  logN: number;
  /** Passphrase on a QR session, recovery code on a typed-code session (spec 8.3 step 7). */
  unlockWith: UnlockSecret;
  /** `qusme_relays`: the queue's storage relays, if present and well-formed. */
  relays?: string[];
  /** From `qusme_npub`: the queue pubkey (hex) to check the unlocked key against. */
  queuePubkey?: string;
}

/** What the source sends; it picks the copy that matches the session (spec 8.3 steps 2, 5). */
export interface SourcePayload {
  /** The device's local copy under the user's passphrase (6.1); sent on a QR session. */
  passphraseCopy?: string;
  /** The published recovery backup's `ncryptsec`, under the recovery code; sent on a typed-code session. */
  recoveryBackup?: string;
  /** The queue's storage relays, sent as `qusme_relays`. */
  relays: readonly string[];
  /** The queue pubkey (hex), sent as `qusme_npub`. */
  queuePubkey: string;
}

/** Options for tests and for callers that keep their own clock. */
export interface PairingOptions {
  /** Milliseconds; defaults to `Date.now()`. Every call takes its own `now` too. */
  now?: number;
  /** The ephemeral secret key. Test vectors only; leave it out and a random one is made. */
  secretKey?: Uint8Array;
  /** Jitter `created_at` as NIP-AB recommends; on unless a test turns it off. */
  jitter?: boolean;
}

export type PairingSourceState =
  | 'waiting'
  | 'confirming'
  | 'sent'
  | 'completed'
  | 'failed'
  | 'unconfirmed'
  | 'aborted';

export type PairingTargetState =
  | 'offered'
  | 'verified'
  | 'importing'
  | 'completed'
  | 'failed'
  | 'refused'
  | 'aborted';

type Message =
  | { type: 'offer'; version: unknown; session_id: unknown }
  | { type: 'sas-confirm'; transcript_hash: unknown }
  | { type: 'payload'; record: Record<string, unknown> }
  | { type: 'complete'; success: boolean }
  | { type: 'abort'; reason: AbortReason }
  | { type: 'other' };

const NONE: PairingStep = { publish: [] };

function readMessage(plaintext: string): Message | undefined {
  let value: unknown;
  try {
    value = parseJsonText(plaintext);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  switch (record.type) {
    case 'offer':
      return { type: 'offer', version: record.version, session_id: record.session_id };
    case 'sas-confirm':
      return { type: 'sas-confirm', transcript_hash: record.transcript_hash };
    case 'payload':
      return { type: 'payload', record };
    case 'complete':
      // NIP-AB: `success` defaults to true. buzz always sends it.
      if (record.success !== undefined && typeof record.success !== 'boolean') return undefined;
      return { type: 'complete', success: record.success !== false };
    case 'abort': {
      const reason = (ABORT_REASONS as readonly unknown[]).includes(record.reason)
        ? (record.reason as AbortReason)
        : 'protocol_error';
      return { type: 'abort', reason };
    }
    default:
      return typeof record.type === 'string' ? { type: 'other' } : undefined;
  }
}

/**
 * NIP-AB event validation steps 1 to 3 and the content bounds of step 5: a signed kind 24134
 * event from a curve-point pubkey, with exactly one `p` tag naming `ownPubkey`. Returns undefined
 * for anything else; the caller discards it silently.
 */
function readPairingEvent(input: unknown, ownPubkey: string): NostrEvent | undefined {
  let event: NostrEvent;
  try {
    event = readSignedEvent(input);
  } catch (error) {
    if (error instanceof Invalid) return undefined;
    throw error;
  }
  if (event.kind !== KIND_PAIRING || !isCurvePoint(event.pubkey)) return undefined;
  const p = event.tags.filter((tag) => tag[0] === 'p');
  if (p.length !== 1 || p[0]?.[1] !== ownPubkey) return undefined;
  if (event.content.length < CONTENT_MIN || event.content.length > CONTENT_MAX) return undefined;
  return event;
}

function decrypt(conversationKey: Uint8Array, event: NostrEvent): Message | undefined {
  // NIP-44 v2 only: nostr-tools refuses any other version byte, a bad MAC and bad padding.
  let plaintext: string;
  try {
    plaintext = nip44DecryptWithKey(conversationKey, event.content);
  } catch {
    return undefined;
  }
  return readMessage(plaintext);
}

/** The `ncryptsec`'s scrypt cost, or undefined if the string is not an acceptable `ncryptsec`. */
function ncryptsecLogN(value: unknown): number | undefined {
  if (typeof value !== 'string' || !value.startsWith('ncryptsec1')) return undefined;
  try {
    const { logN } = ncryptsecParams(value);
    return logN <= NCRYPTSEC_MAX_LOG_N ? logN : undefined;
  } catch {
    return undefined;
  }
}

function readRelayList(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  try {
    return [...new Set(value.map((relay, i) => readRelayUrl(relay, `qusme_relays[${i}]`)))];
  } catch {
    return undefined;
  }
}

function readNpub(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.startsWith('npub1')) return undefined;
  try {
    const decoded = nip19Decode(value);
    return decoded.type === 'npub' && isHex64(decoded.data) ? decoded.data : undefined;
  } catch {
    return undefined;
  }
}

/** True when an unlocked key is the queue key the payload named (spec 8.3 step 7). */
export function matchesQueuePubkey(secretKey: Uint8Array, payload: ReceivedPayload): boolean {
  return payload.queuePubkey !== undefined && getPublicKey(secretKey) === payload.queuePubkey;
}

/** State and helpers both roles share: keys, signing, dedupe, deadlines, wiping. */
abstract class PairingSession {
  readonly pubkey: string;
  readonly relays: readonly string[];
  protected readonly secretKey: Uint8Array;
  protected readonly sessionSecret: Uint8Array;
  protected readonly sessionId: Uint8Array;
  protected sasInput: Uint8Array | undefined;
  protected sasCode: string | undefined;
  protected conversationKey: Uint8Array | undefined;
  protected peer: string | undefined;
  protected readonly processed = new Set<string>();
  protected readonly sessionDeadline: number;
  protected stepDeadline: number | undefined;
  private readonly jitter: boolean;
  private wiped = false;

  protected constructor(
    secretKey: Uint8Array,
    sessionSecret: Uint8Array,
    relays: readonly string[],
    deadline: number,
    jitter: boolean
  ) {
    if (secretKey.length !== 32) throw new Error('secret key must be 32 bytes');
    this.secretKey = secretKey.slice();
    this.pubkey = getPublicKey(this.secretKey);
    this.sessionSecret = sessionSecret.slice();
    this.sessionId = deriveSessionId(this.sessionSecret);
    this.relays = [...relays];
    this.sessionDeadline = deadline;
    this.jitter = jitter;
  }

  /** The filter to subscribe with on every relay of the session. */
  get filter(): { kinds: number[]; '#p': string[] } {
    return pairingFilter(this.pubkey);
  }

  /** The six-digit SAS, once both ephemeral keys are known. */
  get sas(): string | undefined {
    return this.sasCode;
  }

  /** When {@link tick} next has something to do (milliseconds), or undefined once ended. */
  get nextDeadline(): number | undefined {
    if (this.terminal) return undefined;
    return this.stepDeadline === undefined
      ? this.sessionDeadline
      : Math.min(this.stepDeadline, this.sessionDeadline);
  }

  abstract get terminal(): boolean;

  /**
   * Signs a NIP-42 AUTH event (kind 22242) as the session's ephemeral key, for a relay of the
   * session that asks for AUTH (spec 8.3 step 4). Signs nothing else, and nothing once ended.
   */
  signAuth(template: EventTemplate): NostrEvent {
    if (this.wiped) throw new Error('the pairing session has ended');
    if (template.kind !== KIND_RELAY_AUTH)
      throw new Error(`signAuth signs only kind ${KIND_RELAY_AUTH}`);
    return finalizeEvent(template, this.secretKey);
  }

  protected lockPeer(peer: string): void {
    this.peer = peer;
    this.conversationKey = nip44ConversationKey(this.secretKey, peer);
    const ecdh = ecdhShared(this.secretKey, peer);
    const sas = deriveSas(ecdh, this.sessionSecret);
    ecdh.fill(0);
    this.sasInput = sas.input;
    this.sasCode = sas.code;
  }

  protected transcriptHash(sourcePubkey: string, targetPubkey: string): Uint8Array {
    if (this.sasInput === undefined) throw new Error('no SAS yet');
    return deriveTranscriptHash(
      this.sessionId,
      sourcePubkey,
      targetPubkey,
      this.sasInput,
      this.sessionSecret
    );
  }

  /** Encrypts and signs one message to the locked peer. */
  protected message(body: Record<string, unknown>, now: number): NostrEvent {
    if (this.peer === undefined || this.conversationKey === undefined) {
      throw new Error('no peer yet');
    }
    const seconds = Math.floor(now / 1000);
    const jitter = this.jitter
      ? (randomBytes(1)[0] as number) % (PAIRING_CREATED_AT_JITTER + 1)
      : 0;
    return finalizeEvent(
      {
        kind: KIND_PAIRING,
        created_at: seconds - jitter,
        tags: [['p', this.peer]],
        content: nip44EncryptWithKey(this.conversationKey, JSON.stringify(body)),
      },
      this.secretKey
    );
  }

  /** Validation steps 1 to 4 and 7 for an event from the locked peer. */
  protected fromPeer(input: unknown): NostrEvent | undefined {
    const event = readPairingEvent(input, this.pubkey);
    if (event === undefined || event.pubkey !== this.peer || this.processed.has(event.id)) {
      return undefined;
    }
    return event;
  }

  /** An abort to the peer (when there is one) and the matching notice; ends the session. */
  protected abortLocal(reason: AbortReason, now: number): PairingStep {
    const publish = this.peer === undefined ? [] : [this.message({ type: 'abort', reason }, now)];
    this.end();
    return { publish, notice: { type: 'aborted', reason, by: 'local' } };
  }

  /** Overwrites every secret the session holds. Idempotent. */
  protected wipe(): void {
    if (this.wiped) return;
    this.wiped = true;
    this.secretKey.fill(0);
    this.sessionSecret.fill(0);
    this.sessionId.fill(0);
    this.sasInput?.fill(0);
    this.conversationKey?.fill(0);
    this.stepDeadline = undefined;
  }

  protected abstract end(): void;
}

/**
 * The existing device's side (spec 8.3 steps 1, 2, 4, 5). Create it when the user starts
 * pairing, show {@link uri} as a QR code, subscribe with {@link filter} on every relay, and pass
 * each event to {@link receive}.
 */
export class PairingSource extends PairingSession {
  /** The `nostrpair://` URI to show as a QR code and, for a typed code, post to the service. */
  readonly uri: string;
  #state: PairingSourceState = 'waiting';
  #typedCode = false;

  constructor(
    relays: readonly string[],
    options: PairingOptions & { sessionSecret?: Uint8Array } = {}
  ) {
    const now = options.now ?? Date.now();
    const secretKey = options.secretKey ?? randomBytes(32);
    const sessionSecret = options.sessionSecret ?? randomBytes(32);
    super(
      secretKey,
      sessionSecret,
      relays,
      now + PAIRING_SESSION_TIMEOUT_MS,
      options.jitter ?? true
    );
    if (options.secretKey === undefined) secretKey.fill(0);
    if (options.sessionSecret === undefined) sessionSecret.fill(0);
    this.uri = buildPairingUri({
      sourcePubkey: this.pubkey,
      sessionSecret: this.sessionSecret,
      relays: [...this.relays],
    });
  }

  get state(): PairingSourceState {
    return this.#state;
  }

  get terminal(): boolean {
    return !['waiting', 'confirming', 'sent'].includes(this.#state);
  }

  /** Whether a typed code was issued for this session (spec 8.3 step 2). */
  get typedCode(): boolean {
    return this.#typedCode;
  }

  /** What the new device will ask for. */
  get unlockWith(): UnlockSecret {
    return unlockSecretFor(this.#typedCode ? 'typed-code' : 'qr');
  }

  /** When the session ends regardless (milliseconds): a typed code's expiry is at most this. */
  get expiresAt(): number {
    return this.sessionDeadline;
  }

  /**
   * Records that the service issued a typed code for this URI. From then on the session sends
   * the recovery backup, whichever way the target got the URI. Call it before posting, so a
   * code never exists for a session that would send the passphrase copy. Only while waiting.
   */
  markTypedCode(): void {
    if (this.#state !== 'waiting') throw new Error('a typed code is only issued before the offer');
    this.#typedCode = true;
  }

  /** Feeds one event from a relay. Anything invalid, unexpected or repeated is ignored. */
  receive(input: unknown, now: number = Date.now()): PairingStep {
    if (this.terminal) return NONE;
    const expired = this.expire(now);
    if (expired !== undefined) return expired;
    if (this.#state === 'waiting') return this.receiveOffer(input);

    const event = this.fromPeer(input);
    if (event === undefined || this.conversationKey === undefined) return NONE;
    const message = decrypt(this.conversationKey, event);
    if (message === undefined) return NONE;
    if (message.type === 'abort') {
      this.processed.add(event.id);
      this.end('aborted');
      return { publish: [], notice: { type: 'aborted', reason: message.reason, by: 'peer' } };
    }
    if (this.#state === 'sent' && message.type === 'complete') {
      this.processed.add(event.id);
      this.end(message.success ? 'completed' : 'failed');
      return { publish: [], notice: { type: 'complete', success: message.success } };
    }
    return NONE;
  }

  private receiveOffer(input: unknown): PairingStep {
    const event = readPairingEvent(input, this.pubkey);
    if (event === undefined || this.processed.has(event.id)) return NONE;
    let message: Message | undefined;
    const key = nip44ConversationKey(this.secretKey, event.pubkey);
    try {
      message = decrypt(key, event);
    } finally {
      key.fill(0);
    }
    if (message?.type !== 'offer' || message.version !== NIP_AB_VERSION) return NONE;
    if (!isHex64(message.session_id)) return NONE;
    if (!constantTimeEqual(hexToBytes(message.session_id), this.sessionId)) return NONE;
    // Peer lock: the first valid offer wins, and every later event must come from its key.
    this.lockPeer(event.pubkey);
    this.processed.add(event.id);
    this.#state = 'confirming';
    return { publish: [], notice: { type: 'sas', sas: this.sasCode as string } };
  }

  /**
   * The user confirmed that both screens show the same SAS. Returns `sas-confirm` and `payload`,
   * to publish in that order to every relay. Throws if the session needs a copy the caller did
   * not pass, if that copy is not an `ncryptsec`, or on a malformed relay list or pubkey.
   */
  confirmSas(payload: SourcePayload, now: number = Date.now()): PairingStep {
    if (this.#state !== 'confirming')
      throw new Error(`cannot confirm the SAS while ${this.#state}`);
    const expired = this.expire(now);
    if (expired !== undefined) return expired;
    const ncryptsec = this.#typedCode ? payload.recoveryBackup : payload.passphraseCopy;
    if (ncryptsecLogN(ncryptsec) === undefined) {
      throw new Error(
        this.#typedCode
          ? 'a typed-code session sends the recovery backup, as an ncryptsec'
          : 'a QR session sends the passphrase copy, as an ncryptsec'
      );
    }
    const relays = payload.relays.map((relay, i) => readRelayUrlOrThrow(relay, i));
    if (relays.length === 0) throw new Error('qusme_relays needs at least one relay');
    if (!isHex64(payload.queuePubkey)) throw new Error('queuePubkey must be 64 lowercase hex');
    const peer = this.peer as string;
    const hash = this.transcriptHash(this.pubkey, peer);
    const publish = [
      this.message({ type: 'sas-confirm', transcript_hash: bytesToHex(hash) }, now),
      this.message(
        {
          type: 'payload',
          payload_type: 'nsec',
          payload: ncryptsec,
          qusme_relays: relays,
          qusme_npub: npubEncode(payload.queuePubkey),
        },
        now
      ),
    ];
    hash.fill(0);
    this.#state = 'sent';
    this.stepDeadline = now + PAIRING_STEP_TIMEOUT_MS;
    return { publish };
  }

  /** The user said the codes differ, or cancelled: `abort` with `user_denied`. */
  deny(now: number = Date.now()): PairingStep {
    if (this.terminal) return NONE;
    return this.abortLocal('user_denied', now);
  }

  /** Call at {@link nextDeadline}: ends a session that ran out of time. */
  tick(now: number = Date.now()): PairingStep {
    if (this.terminal) return NONE;
    return this.expire(now) ?? NONE;
  }

  private expire(now: number): PairingStep | undefined {
    if (this.#state === 'sent' && this.stepDeadline !== undefined && now >= this.stepDeadline) {
      // NIP-AB: no `complete` in 30 s is an ambiguous success, not an error.
      this.end('unconfirmed');
      return { publish: [], notice: { type: 'unconfirmed' } };
    }
    if (now >= this.sessionDeadline) {
      if (this.#state === 'sent') {
        this.end('unconfirmed');
        return { publish: [], notice: { type: 'unconfirmed' } };
      }
      return this.abortLocal('timeout', now);
    }
    return undefined;
  }

  protected end(state: PairingSourceState = 'aborted'): void {
    this.#state = state;
    this.wipe();
  }
}

function readRelayUrlOrThrow(relay: string, i: number): string {
  try {
    return readRelayUrl(relay, `relays[${i}]`);
  } catch (error) {
    if (error instanceof Invalid) throw new Error(`invalid relay: ${error.message}`);
    throw error;
  }
}

/**
 * The new device's side (spec 8.3 steps 3, 4, 6). Create it from a parsed URI, publish
 * {@link offer} to the first relay that connects (re-publish the same event elsewhere if that
 * relay fails), subscribe with {@link filter} on every relay, show {@link sas} at once, and pass
 * each event to {@link receive} and the user's decision to {@link confirmSas} or {@link deny}.
 */
export class PairingTarget extends PairingSession {
  /** The signed `offer`. */
  readonly offer: NostrEvent;
  /** How the URI arrived; decides what {@link unlockWith} asks for. */
  readonly channel: PairingChannel;
  #state: PairingTargetState = 'offered';
  #userConfirmed = false;
  #buffered: NostrEvent | undefined;

  constructor(
    uri: PairingUri,
    channel: PairingChannel,
    options: PairingOptions & { deadline?: number } = {}
  ) {
    const now = options.now ?? Date.now();
    const secretKey = options.secretKey ?? randomBytes(32);
    const deadline = Math.min(now + PAIRING_SESSION_TIMEOUT_MS, options.deadline ?? Infinity);
    super(secretKey, uri.sessionSecret, uri.relays, deadline, options.jitter ?? true);
    if (options.secretKey === undefined) secretKey.fill(0);
    this.channel = channel;
    this.lockPeer(uri.sourcePubkey);
    this.offer = this.message(
      { type: 'offer', version: NIP_AB_VERSION, session_id: bytesToHex(this.sessionId) },
      now
    );
  }

  get state(): PairingTargetState {
    return this.#state;
  }

  get terminal(): boolean {
    return !['offered', 'verified', 'importing'].includes(this.#state);
  }

  /** The source's ephemeral pubkey. */
  get sourcePubkey(): string {
    return this.peer as string;
  }

  /** Whether the user has confirmed the SAS on this device. */
  get userConfirmed(): boolean {
    return this.#userConfirmed;
  }

  get unlockWith(): UnlockSecret {
    return unlockSecretFor(this.channel);
  }

  /** Feeds one event from a relay. Anything invalid, unexpected or repeated is ignored. */
  receive(input: unknown, now: number = Date.now()): PairingStep {
    if (this.terminal) return NONE;
    const expired = this.expire(now);
    if (expired !== undefined) return expired;
    const event = this.fromPeer(input);
    if (event === undefined || this.conversationKey === undefined) return NONE;
    const message = decrypt(this.conversationKey, event);
    if (message === undefined) return NONE;

    if (message.type === 'abort') {
      this.processed.add(event.id);
      this.end('aborted');
      return { publish: [], notice: { type: 'aborted', reason: message.reason, by: 'peer' } };
    }
    if (message.type === 'payload' && this.#state !== 'importing') {
      // Held unread: relays may deliver it before `sas-confirm`, and it is read only after both
      // the transcript check and the user's confirmation. Only the first is kept.
      if (this.#buffered !== undefined) return NONE;
      this.processed.add(event.id);
      this.#buffered = event;
      if (this.#state === 'verified') this.stepDeadline = undefined;
      return this.release(now) ?? NONE;
    }
    if (message.type === 'sas-confirm' && this.#state === 'offered') {
      this.processed.add(event.id);
      const expected = this.transcriptHash(this.peer as string, this.pubkey);
      const received = isHex64(message.transcript_hash)
        ? hexToBytes(message.transcript_hash)
        : new Uint8Array(0);
      const match = constantTimeEqual(received, expected);
      expected.fill(0);
      if (!match) {
        this.#buffered = undefined;
        return this.abortLocal('sas_mismatch', now);
      }
      this.#state = 'verified';
      if (this.#buffered === undefined) this.stepDeadline = now + PAIRING_STEP_TIMEOUT_MS;
      return this.release(now) ?? { publish: [], notice: { type: 'verified' } };
    }
    return NONE;
  }

  /**
   * The user confirmed that both screens show the same SAS. Allowed before or after the source's
   * `sas-confirm` arrives; the payload is released once both have happened.
   */
  confirmSas(now: number = Date.now()): PairingStep {
    if (this.terminal) return NONE;
    if (this.#state === 'importing') return NONE;
    const expired = this.expire(now);
    if (expired !== undefined) return expired;
    this.#userConfirmed = true;
    return this.release(now) ?? NONE;
  }

  /** The user said the codes differ, or cancelled: `abort` with `user_denied`. */
  deny(now: number = Date.now()): PairingStep {
    if (this.terminal) return NONE;
    this.#buffered = undefined;
    return this.abortLocal('user_denied', now);
  }

  /**
   * After the `payload` notice: the device stored the `ncryptsec` (or failed to). Returns
   * `complete`, to publish to every relay before prompting for the passphrase or recovery code,
   * since the source waits only 30 seconds for it (spec 8.3 step 6).
   */
  stored(success: boolean, now: number = Date.now()): PairingStep {
    if (this.#state !== 'importing') throw new Error(`nothing to store while ${this.#state}`);
    const publish = [this.message({ type: 'complete', success }, now)];
    this.end(success ? 'completed' : 'failed');
    return { publish };
  }

  /** Call at {@link nextDeadline}: ends a session that ran out of time. */
  tick(now: number = Date.now()): PairingStep {
    if (this.terminal) return NONE;
    return this.expire(now) ?? NONE;
  }

  private expire(now: number): PairingStep | undefined {
    // Once the payload is in hand, `complete` is advisory and the clock no longer matters.
    if (this.#state === 'importing') return undefined;
    const stepOver = this.stepDeadline !== undefined && now >= this.stepDeadline;
    if (now >= this.sessionDeadline || stepOver) {
      this.#buffered = undefined;
      return this.abortLocal('timeout', now);
    }
    return undefined;
  }

  /** Hands the buffered payload over once the transcript verified and the user confirmed. */
  private release(now: number): PairingStep | undefined {
    if (this.#state !== 'verified' || !this.#userConfirmed || this.#buffered === undefined) {
      return undefined;
    }
    const event = this.#buffered;
    this.#buffered = undefined;
    const message = this.conversationKey && decrypt(this.conversationKey, event);
    if (message?.type !== 'payload') return this.refuse('unsupported_payload_type', now);
    const { record } = message;
    // buzz requires `payload_type`; the PR text leaves it out, so a missing one reads as nsec.
    if (record.payload_type !== undefined && record.payload_type !== 'nsec') {
      return this.refuse('unsupported_payload_type', now);
    }
    const logN = ncryptsecLogN(record.payload);
    if (logN === undefined) return this.refuse('not_ncryptsec', now);
    const payload: ReceivedPayload = {
      ncryptsec: record.payload as string,
      logN,
      unlockWith: this.unlockWith,
    };
    const relays = readRelayList(record.qusme_relays);
    if (relays !== undefined) payload.relays = relays;
    const queuePubkey = readNpub(record.qusme_npub);
    if (queuePubkey !== undefined) payload.queuePubkey = queuePubkey;
    this.#state = 'importing';
    this.stepDeadline = undefined;
    return { publish: [], notice: { type: 'payload', payload } };
  }

  private refuse(reason: 'not_ncryptsec' | 'unsupported_payload_type', now: number): PairingStep {
    const publish = [this.message({ type: 'complete', success: false }, now)];
    this.end('refused');
    return { publish, notice: { type: 'refused', reason } };
  }

  protected end(state: PairingTargetState = 'aborted'): void {
    this.#state = state;
    this.#buffered = undefined;
    this.wipe();
  }
}

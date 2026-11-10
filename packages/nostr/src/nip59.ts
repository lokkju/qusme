import { randomBytes } from '@noble/hashes/utils.js';
import type { EventTemplate, NostrEvent, UnsignedEvent } from 'nostr-tools/core';
import { validateEvent } from 'nostr-tools/core';
import {
  finalizeEvent,
  generateSecretKey,
  getEventHash,
  getPublicKey,
  verifyEvent,
} from 'nostr-tools/pure';
import { KIND_GIFT_WRAP, KIND_SEAL } from './kinds.ts';
import { minePow } from './nip13.ts';
import { nip44Encrypt } from './nip44.ts';
import type { Signer } from './signer.ts';

/**
 * How far into the past NIP-59 timestamps are randomized, in seconds. Ingestion queries with a
 * lookback longer than this (spec 11.4).
 */
export const NIP59_TIMESTAMP_JITTER = 2 * 24 * 60 * 60;

/** An unsigned event with its id: the innermost layer of a gift wrap. */
export type Rumor = UnsignedEvent & { id: string };

/** What a rumor is made from; `created_at` defaults to now. */
export type RumorTemplate = Pick<EventTemplate, 'kind'> & Partial<EventTemplate>;

export interface TimestampOptions {
  /** The current time in unix seconds; defaults to the clock. For tests. */
  now?: number;
}

export interface GiftWrapOptions extends TimestampOptions {
  /**
   * NIP-40 `expiration` for the gift wrap, in unix seconds. It must be after `now`. It goes on the
   * wrap only: NIP-59 requires the seal's tags to be empty.
   */
  expiration?: number;
  /**
   * NIP-13 difficulty for the gift wrap's id (spec 7.4 `min_pow`), mined on the wrap only; 0 or
   * absent for none.
   */
  pow?: number;
  /**
   * Most bytes of serialized wrap to hash while mining `pow`; unbounded when absent. Mining throws
   * `PowBudgetExceeded` rather than go past it (spec 7.4).
   */
  powMaxBytes?: number;
}

export interface Unwrapped {
  /** The rumor, its id checked against its content. */
  rumor: Rumor;
  /** The seal's pubkey, which signed the seal and equals the rumor's pubkey: the real sender. */
  sealPubkey: string;
  /** The gift wrap's id, from which ingestion derives the draft's `d` tag (spec 11.4). */
  wrapId: string;
  /** The gift wrap's NIP-40 expiration, when it has one. */
  expiration?: number;
}

/** What {@link unwrapGiftWrap} may be told to check between layers. */
export interface UnwrapOptions {
  /**
   * Called with the seal's pubkey once the gift wrap layer is decrypted, before the seal's
   * signature is verified or the rumor decrypted (spec 11.4). Returning false stops the unwrap
   * with a {@link SealRefused}, so an unknown sender costs one ECDH, not three.
   */
  acceptSeal?: (sealPubkey: string) => boolean;
}

/** {@link UnwrapOptions.acceptSeal} refused the seal's pubkey. */
export class SealRefused extends Error {
  readonly sealPubkey: string;
  constructor(sealPubkey: string) {
    super('seal pubkey is not accepted');
    this.sealPubkey = sealPubkey;
  }
}

const currentTime = (options: TimestampOptions): number =>
  options.now ?? Math.floor(Date.now() / 1000);

/** A time uniformly up to {@link NIP59_TIMESTAMP_JITTER} before `now`, never in the future. */
export function randomizedTimestamp(options: TimestampOptions = {}): number {
  const [a = 0, b = 0, c = 0, d = 0] = randomBytes(4);
  const random = ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
  return currentTime(options) - (random % (NIP59_TIMESTAMP_JITTER + 1));
}

/** Builds a rumor authored by `pubkey`. A rumor is never signed. */
export function createRumor(template: RumorTemplate, pubkey: string): Rumor {
  const unsigned: UnsignedEvent = {
    kind: template.kind,
    tags: template.tags ?? [],
    content: template.content ?? '',
    created_at: template.created_at ?? Math.floor(Date.now() / 1000),
    pubkey,
  };
  return { ...unsigned, id: getEventHash(unsigned) };
}

/**
 * Seals a rumor (kind 13): the rumor NIP-44-encrypted from the signer to the recipient, signed by
 * the signer, with empty tags and a randomized `created_at`. The signer must be the rumor's author.
 */
export async function createSeal(
  rumor: Rumor,
  signer: Signer,
  recipientPubkey: string,
  options: TimestampOptions = {}
): Promise<NostrEvent> {
  const author = await signer.getPublicKey();
  if (rumor.pubkey !== author) throw new Error('rumor pubkey differs from the sealing key');
  const content = await signer.nip44Encrypt(recipientPubkey, JSON.stringify(rumor));
  return signer.signEvent({
    kind: KIND_SEAL,
    tags: [],
    content,
    created_at: randomizedTimestamp(options),
  });
}

/**
 * Gift-wraps a seal (kind 1059) with a fresh ephemeral key: `p`-tagged to the recipient, with a
 * randomized `created_at`, an optional NIP-40 `expiration` and optional NIP-13 work on its id.
 */
export function createGiftWrap(
  seal: NostrEvent,
  recipientPubkey: string,
  options: GiftWrapOptions = {}
): NostrEvent {
  const tags = [['p', recipientPubkey]];
  if (options.expiration !== undefined) {
    if (!Number.isInteger(options.expiration) || options.expiration <= currentTime(options)) {
      throw new Error('gift wrap expiration must be a unix time in the future');
    }
    tags.push(['expiration', String(options.expiration)]);
  }
  const ephemeralKey = generateSecretKey();
  try {
    let template: EventTemplate = {
      kind: KIND_GIFT_WRAP,
      tags,
      content: nip44Encrypt(ephemeralKey, recipientPubkey, JSON.stringify(seal)),
      created_at: randomizedTimestamp(options),
    };
    if (options.pow !== undefined && options.pow > 0) {
      const mined = minePow(
        { ...template, pubkey: getPublicKey(ephemeralKey) },
        options.pow,
        options.powMaxBytes === undefined ? {} : { maxBytes: options.powMaxBytes }
      );
      template = { ...template, tags: mined.tags };
    }
    return finalizeEvent(template, ephemeralKey);
  } finally {
    ephemeralKey.fill(0);
  }
}

/** Rumor, seal and gift wrap in one call, authored and sealed by `signer`. */
export async function giftWrap(
  template: RumorTemplate,
  signer: Signer,
  recipientPubkey: string,
  options: GiftWrapOptions = {}
): Promise<NostrEvent> {
  const rumor = createRumor(template, await signer.getPublicKey());
  const seal = await createSeal(rumor, signer, recipientPubkey, options);
  return createGiftWrap(seal, recipientPubkey, options);
}

// The fields of a signed event and nothing else, so verifyEvent can't trust a cached verdict.
function signedFields(value: unknown, layer: string): NostrEvent {
  if (!validateEvent(value)) throw new Error(`${layer} is not a valid event`);
  const event = value as UnsignedEvent & { id?: unknown; sig?: unknown };
  if (typeof event.id !== 'string' || typeof event.sig !== 'string') {
    throw new Error(`${layer} is not signed`);
  }
  const { kind, tags, content, created_at, pubkey, id, sig } = event;
  return { kind, tags, content, created_at, pubkey, id, sig };
}

function parseJson(text: string, layer: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${layer} is not JSON`);
  }
}

/**
 * Opens a gift wrap addressed to the signer and returns the rumor and the seal's pubkey. Throws
 * unless the wrap and seal are the right kinds with valid signatures, the seal's tags are empty,
 * the rumor is unsigned with a correct id, and the rumor's pubkey equals the seal's. Pass
 * `acceptSeal` to check the seal's pubkey against the submitters list before the costlier layers
 * (spec 11.4); without it the caller still has to check it.
 */
export async function unwrapGiftWrap(
  wrapEvent: NostrEvent,
  signer: Signer,
  options: UnwrapOptions = {}
): Promise<Unwrapped> {
  const wrap = signedFields(wrapEvent, 'gift wrap');
  if (wrap.kind !== KIND_GIFT_WRAP) throw new Error(`expected kind ${KIND_GIFT_WRAP}`);
  if (!verifyEvent(wrap)) throw new Error('gift wrap signature is invalid');

  const sealText = await signer.nip44Decrypt(wrap.pubkey, wrap.content);
  const seal = signedFields(parseJson(sealText, 'seal'), 'seal');
  if (seal.kind !== KIND_SEAL) throw new Error(`expected a kind ${KIND_SEAL} seal`);
  if (seal.tags.length !== 0) throw new Error('seal tags must be empty');
  if (options.acceptSeal !== undefined && !options.acceptSeal(seal.pubkey)) {
    throw new SealRefused(seal.pubkey);
  }
  if (!verifyEvent(seal)) throw new Error('seal signature is invalid');

  const rumorValue = parseJson(await signer.nip44Decrypt(seal.pubkey, seal.content), 'rumor');
  if (!validateEvent(rumorValue)) throw new Error('rumor is not a valid event');
  const rumorFields = rumorValue as UnsignedEvent & { id?: unknown; sig?: unknown };
  if (rumorFields.sig !== undefined) throw new Error('rumor must not be signed');
  const { kind, tags, content, created_at, pubkey, id } = rumorFields;
  const unsigned: UnsignedEvent = { kind, tags, content, created_at, pubkey };
  if (id !== getEventHash(unsigned)) throw new Error('rumor id does not match its content');
  if (pubkey !== seal.pubkey) throw new Error('rumor pubkey differs from the seal pubkey');

  const result: Unwrapped = {
    rumor: { ...unsigned, id },
    sealPubkey: seal.pubkey,
    wrapId: wrap.id,
  };
  const expirationTag = wrap.tags.find((tag) => tag[0] === 'expiration');
  if (expirationTag?.[1] !== undefined && /^\d+$/.test(expirationTag[1])) {
    result.expiration = Number(expirationTag[1]);
  }
  return result;
}

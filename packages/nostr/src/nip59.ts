import { randomBytes } from '@noble/hashes/utils.js';
import type { EventTemplate, NostrEvent, UnsignedEvent } from 'nostr-tools/core';
import { validateEvent } from 'nostr-tools/core';
import { finalizeEvent, generateSecretKey, getEventHash, verifyEvent } from 'nostr-tools/pure';
import { nip44Encrypt } from './nip44.ts';
import type { Signer } from './signer.ts';

/** NIP-59 seal. */
export const KIND_SEAL = 13;
/** NIP-59 gift wrap. */
export const KIND_GIFT_WRAP = 1059;
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
 * randomized `created_at` and an optional NIP-40 `expiration`.
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
  return finalizeEvent(
    {
      kind: KIND_GIFT_WRAP,
      tags,
      content: nip44Encrypt(ephemeralKey, recipientPubkey, JSON.stringify(seal)),
      created_at: randomizedTimestamp(options),
    },
    ephemeralKey
  );
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
 * the rumor is unsigned with a correct id, and the rumor's pubkey equals the seal's. The caller
 * still checks that the seal's pubkey is an authorized submitter (spec 11.4).
 */
export async function unwrapGiftWrap(wrapEvent: NostrEvent, signer: Signer): Promise<Unwrapped> {
  const wrap = signedFields(wrapEvent, 'gift wrap');
  if (wrap.kind !== KIND_GIFT_WRAP) throw new Error(`expected kind ${KIND_GIFT_WRAP}`);
  if (!verifyEvent(wrap)) throw new Error('gift wrap signature is invalid');

  const sealText = await signer.nip44Decrypt(wrap.pubkey, wrap.content);
  const seal = signedFields(parseJson(sealText, 'seal'), 'seal');
  if (seal.kind !== KIND_SEAL) throw new Error(`expected a kind ${KIND_SEAL} seal`);
  if (seal.tags.length !== 0) throw new Error('seal tags must be empty');
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

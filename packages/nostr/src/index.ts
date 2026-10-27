/**
 * Event builders and parsers for the kinds in spec section 7, and NIP-44/49/59 helpers. Shared by
 * the service, the extension and the PWA, so every client builds and parses events identically.
 */

export type { EventTemplate, NostrEvent, UnsignedEvent } from 'nostr-tools/core';
export {
  nip44ConversationKey,
  nip44Decrypt,
  nip44DecryptFromSelf,
  nip44DecryptWithKey,
  nip44Encrypt,
  nip44EncryptToSelf,
  nip44EncryptWithKey,
} from './nip44.ts';
export {
  decodeNcryptsec,
  encodeNcryptsec,
  type KeySecurity,
  NCRYPTSEC_DEFAULT_LOG_N,
  NCRYPTSEC_MAX_LOG_N,
  NCRYPTSEC_MIN_LOG_N,
  type NcryptsecOptions,
  type NcryptsecParams,
  ncryptsecParams,
} from './nip49.ts';
export {
  createGiftWrap,
  createRumor,
  createSeal,
  type GiftWrapOptions,
  giftWrap,
  KIND_GIFT_WRAP,
  KIND_SEAL,
  NIP59_TIMESTAMP_JITTER,
  type Rumor,
  type RumorTemplate,
  randomizedTimestamp,
  type TimestampOptions,
  type Unwrapped,
  unwrapGiftWrap,
} from './nip59.ts';
export { createLocalSigner, type Signer } from './signer.ts';

/** NIP-37 draft wrap (spec 7.1). */
export const KIND_DRAFT_WRAP = 31234;

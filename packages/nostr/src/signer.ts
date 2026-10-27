import type { EventTemplate, NostrEvent } from 'nostr-tools/core';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { nip44ConversationKey, nip44DecryptWithKey, nip44EncryptWithKey } from './nip44.ts';

/**
 * What callers need from whoever holds a key (spec 6.3). The method names and argument order
 * follow NIP-07's `window.nostr` (`nip44.encrypt(pubkey, plaintext)`), so a NIP-07 or NIP-46
 * signer can be adapted to it without touching callers. Every method is async because remote
 * signers are.
 */
export interface Signer {
  /** The signer's public key, lowercase hex. */
  getPublicKey(): Promise<string>;
  /** Sets `pubkey`, `id` and `sig` on the template and returns the signed event. */
  signEvent(template: EventTemplate): Promise<NostrEvent>;
  /** NIP-44 v2 encryption from the signer's key to `pubkey`. */
  nip44Encrypt(pubkey: string, plaintext: string): Promise<string>;
  /** NIP-44 v2 decryption of a payload sent to the signer's key by `pubkey`. */
  nip44Decrypt(pubkey: string, payload: string): Promise<string>;
}

/**
 * A signer over a secret key held in memory. Conversation keys are cached per peer, since a
 * device decrypting N drafts encrypted to itself would otherwise repeat the same ECDH N times.
 */
export function createLocalSigner(secretKey: Uint8Array): Signer {
  if (secretKey.length !== 32) throw new Error('secret key must be 32 bytes');
  const key = secretKey.slice();
  const pubkey = getPublicKey(key);
  const conversationKeys = new Map<string, Uint8Array>();
  const conversationKey = (peer: string): Uint8Array => {
    let ck = conversationKeys.get(peer);
    if (ck === undefined) {
      ck = nip44ConversationKey(key, peer);
      conversationKeys.set(peer, ck);
    }
    return ck;
  };
  return {
    getPublicKey: async () => pubkey,
    signEvent: async (template) => finalizeEvent(template, key),
    nip44Encrypt: async (peer, plaintext) => nip44EncryptWithKey(conversationKey(peer), plaintext),
    nip44Decrypt: async (peer, payload) => nip44DecryptWithKey(conversationKey(peer), payload),
  };
}

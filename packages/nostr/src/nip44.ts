import { v2 } from 'nostr-tools/nip44';
import type { Signer } from './signer.ts';

/**
 * The NIP-44 v2 conversation key between a secret key and a public key (lowercase hex). It is
 * symmetric: A's secret key with B's pubkey gives the same key as B's secret key with A's pubkey.
 */
export function nip44ConversationKey(secretKey: Uint8Array, pubkey: string): Uint8Array {
  return v2.utils.getConversationKey(secretKey, pubkey);
}

/**
 * Encrypts with a conversation key. `nonce` is for test vectors only; leave it out and a fresh
 * random nonce is used, which NIP-44 requires.
 */
export function nip44EncryptWithKey(
  conversationKey: Uint8Array,
  plaintext: string,
  nonce?: Uint8Array
): string {
  return v2.encrypt(plaintext, conversationKey, nonce);
}

/** Decrypts with a conversation key; throws on a bad version, MAC, padding or length. */
export function nip44DecryptWithKey(conversationKey: Uint8Array, payload: string): string {
  return v2.decrypt(payload, conversationKey);
}

/** NIP-44 v2 encryption from `secretKey` to `recipientPubkey`. */
export function nip44Encrypt(
  secretKey: Uint8Array,
  recipientPubkey: string,
  plaintext: string
): string {
  return nip44EncryptWithKey(nip44ConversationKey(secretKey, recipientPubkey), plaintext);
}

/** NIP-44 v2 decryption of a payload that `senderPubkey` encrypted to `secretKey`. */
export function nip44Decrypt(secretKey: Uint8Array, senderPubkey: string, payload: string): string {
  return nip44DecryptWithKey(nip44ConversationKey(secretKey, senderPubkey), payload);
}

/**
 * Encrypts to the signer's own pubkey, as draft wraps and app data are encrypted to the queue key
 * (spec 7.1, 7.2). Works with any signer, including a remote one.
 */
export async function nip44EncryptToSelf(signer: Signer, plaintext: string): Promise<string> {
  return signer.nip44Encrypt(await signer.getPublicKey(), plaintext);
}

/** Decrypts a payload the signer encrypted to itself. */
export async function nip44DecryptFromSelf(signer: Signer, payload: string): Promise<string> {
  return signer.nip44Decrypt(await signer.getPublicKey(), payload);
}

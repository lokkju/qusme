import type { NostrEvent } from 'nostr-tools/core';
import { KIND_PRIVATE_RELAYS } from './kinds.ts';
import { captureAsync, checkInput, Invalid, type ParseResult } from './result.ts';
import type { Signer } from './signer.ts';
import {
  checkKind,
  decryptWith,
  parseJsonText,
  readArray,
  readRelayUrl,
  readSignedEvent,
} from './validate.ts';

export interface PrivateRelayList {
  id: string;
  pubkey: string;
  createdAt: number;
  relays: string[];
}

function readRelayTags(value: unknown): string[] {
  const relays = readArray(value, 'content').map((tag, i) => {
    const path = `content[${i}]`;
    if (!Array.isArray(tag) || tag.length !== 2 || tag[0] !== 'relay') {
      throw new Invalid('invalid_content', 'expected ["relay", url]', path);
    }
    return readRelayUrl(tag[1], `${path}[1]`);
  });
  if (relays.length === 0) throw new Invalid('invalid_content', 'lists no relay', 'content');
  return relays;
}

/**
 * Builds the NIP-37 private storage relay list (kind 10013): `relay` tags as private tags,
 * NIP-44-encrypted to the signer. The queue's private relay is the first entry (spec 7, 8.3).
 */
export async function buildPrivateRelayList(
  signer: Signer,
  relays: string[],
  options: { createdAt?: number } = {}
): Promise<NostrEvent> {
  const tags = relays.map((url) => ['relay', url]);
  checkInput('relay list', () => readRelayTags(tags));
  const pubkey = await signer.getPublicKey();
  return signer.signEvent({
    kind: KIND_PRIVATE_RELAYS,
    created_at: options.createdAt ?? Math.floor(Date.now() / 1000),
    tags: [],
    content: await signer.nip44Encrypt(pubkey, JSON.stringify(tags)),
  });
}

/** Parses and decrypts a kind 10013 signed by the signer's key. */
export function parsePrivateRelayList(
  event: unknown,
  signer: Signer
): Promise<ParseResult<PrivateRelayList>> {
  return captureAsync(async () => {
    const signed = readSignedEvent(event);
    checkKind(signed.kind, [KIND_PRIVATE_RELAYS]);
    const owner = await signer.getPublicKey();
    if (signed.pubkey !== owner)
      throw new Invalid('wrong_author', 'not signed by this key', 'pubkey');
    const relays = readRelayTags(parseJsonText(await decryptWith(signer, owner, signed.content)));
    return { id: signed.id, pubkey: signed.pubkey, createdAt: signed.created_at, relays };
  });
}

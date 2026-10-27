import type { NostrEvent } from 'nostr-tools/core';
import { KIND_SUBMITTERS, SUBMITTERS_KINDS } from './kinds.ts';
import { capture, captureAsync, checkInput, Invalid, type ParseResult } from './result.ts';
import type { Signer } from './signer.ts';
import {
  checkKeys,
  checkKind,
  decryptWith,
  isHex64,
  parseJsonText,
  readInteger,
  readRecord,
  readSignedEvent,
  readString,
} from './validate.ts';

/** A submitter's private label (spec 7.3). Keys are the JSON keys. */
export interface SubmitterLabel {
  label: string;
  authorized_at: number;
}

/** What anyone listed, and the relay, can read: the public `p` tags. */
export interface SubmittersPublic {
  id: string;
  /** The queue pubkey. */
  pubkey: string;
  createdAt: number;
  /** Agent pubkeys, in tag order. */
  submitters: string[];
}

/** The list as the queue key reads it, with the decrypted labels. */
export interface SubmittersList extends SubmittersPublic {
  /** Keyed by agent pubkey; exactly the pubkeys in {@link SubmittersPublic.submitters}. */
  labels: Record<string, SubmitterLabel>;
}

function readLabels(value: unknown): Record<string, SubmitterLabel> {
  const record = readRecord(value, 'content');
  const labels: Record<string, SubmitterLabel> = {};
  for (const [pubkey, entry] of Object.entries(record)) {
    const path = `content.${pubkey}`;
    if (!isHex64(pubkey)) throw new Invalid('invalid_content', 'key is not a pubkey', path);
    const item = readRecord(entry, path);
    checkKeys(item, path, ['label', 'authorized_at']);
    labels[pubkey] = {
      label: readString(item.label, `${path}.label`),
      authorized_at: readInteger(item.authorized_at, `${path}.authorized_at`, { min: 0 }),
    };
  }
  return labels;
}

function readPublic(event: unknown): SubmittersPublic & { content: string } {
  const signed = readSignedEvent(event);
  checkKind(signed.kind, SUBMITTERS_KINDS);
  const submitters: string[] = [];
  signed.tags.forEach((tag, i) => {
    if (tag[0] !== 'p') return;
    const path = `tags[${i}]`;
    // NIP-01 allows a relay hint after the pubkey; this list never writes one, but a hint is harmless.
    if (tag.length > 3 || !isHex64(tag[1])) throw new Invalid('invalid_tags', 'bad p tag', path);
    if (submitters.includes(tag[1])) throw new Invalid('invalid_tags', 'repeated pubkey', path);
    submitters.push(tag[1]);
  });
  return {
    id: signed.id,
    pubkey: signed.pubkey,
    createdAt: signed.created_at,
    submitters,
    content: signed.content,
  };
}

/**
 * Builds the submitters list (`KIND_SUBMITTERS`, spec 7.3): a public `p` tag per agent, so the
 * relay can enforce writes, and the labels NIP-44-encrypted to the queue key.
 */
export async function buildSubmittersList(
  signer: Signer,
  labels: Record<string, SubmitterLabel>,
  options: { createdAt?: number } = {}
): Promise<NostrEvent> {
  const checked = checkInput('submitter labels', () =>
    readLabels(JSON.parse(JSON.stringify(labels)))
  );
  const pubkey = await signer.getPublicKey();
  return signer.signEvent({
    kind: KIND_SUBMITTERS,
    created_at: options.createdAt ?? Math.floor(Date.now() / 1000),
    tags: Object.keys(checked).map((agent) => ['p', agent]),
    content: await signer.nip44Encrypt(pubkey, JSON.stringify(checked)),
  });
}

/**
 * Reads the public part of a submitters list, as the relay and an agent key do (spec 8.2, 9.1).
 * With `queuePubkey`, the list must be signed by it.
 */
export function parseSubmittersPublic(
  event: unknown,
  options: { queuePubkey?: string } = {}
): ParseResult<SubmittersPublic> {
  return capture(() => {
    const { content: _, ...parsed } = readPublic(event);
    if (options.queuePubkey !== undefined && parsed.pubkey !== options.queuePubkey) {
      throw new Invalid('wrong_author', 'not signed by the queue key', 'pubkey');
    }
    return parsed;
  });
}

/**
 * Parses and decrypts a submitters list with the queue key's signer. The labels must name exactly
 * the `p`-tagged pubkeys.
 */
export function parseSubmittersList(
  event: unknown,
  signer: Signer
): Promise<ParseResult<SubmittersList>> {
  return captureAsync(async () => {
    const { content, ...parsed } = readPublic(event);
    const owner = await signer.getPublicKey();
    if (parsed.pubkey !== owner)
      throw new Invalid('wrong_author', 'not signed by this key', 'pubkey');
    const labels = readLabels(parseJsonText(await decryptWith(signer, owner, content)));
    const labelled = Object.keys(labels);
    if (
      labelled.length !== parsed.submitters.length ||
      !labelled.every((agent) => parsed.submitters.includes(agent))
    ) {
      throw new Invalid('invalid_content', 'labels do not match the p tags', 'content');
    }
    return { ...parsed, labels };
  });
}

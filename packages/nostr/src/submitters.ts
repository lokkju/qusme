import type { NostrEvent } from 'nostr-tools/core';
import { KIND_SUBMITTERS, SUBMITTERS_KINDS } from './kinds.ts';
import { capture, captureAsync, checkInput, Invalid, type ParseResult } from './result.ts';
import type { Signer } from './signer.ts';
import {
  checkExtraTags,
  checkKind,
  decryptWith,
  extraTagsOf,
  isHex64,
  type JsonObject,
  type JsonValue,
  parseJsonText,
  readExtra,
  readInteger,
  readRecord,
  readSignedEvent,
  readString,
  withExtra,
} from './validate.ts';

const LABEL_KEYS = ['label', 'authorized_at'];

/** A submitter's private label (spec 7.3). Keys are the JSON keys. */
export interface SubmitterLabel {
  label: string;
  authorized_at: number;
  /** Keys this version does not know, kept for republishing (spec 7, "Unknown fields"). */
  extra?: JsonObject;
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
  /** Content keys that are not pubkeys, kept for republishing. */
  extra?: JsonObject;
  /** Event tags other than `p`, kept for republishing. */
  extraTags?: string[][];
}

export interface SubmittersOptions {
  createdAt?: number;
  /** Content keys that are not pubkeys, from a parse. */
  extra?: JsonObject;
  /** Tags other than `p`, from a parse; written after the `p` tags. */
  extraTags?: string[][];
}

function readLabels(value: unknown): {
  labels: Record<string, SubmitterLabel>;
  extra: JsonObject | undefined;
} {
  const record = readRecord(value, 'content');
  const pubkeys = Object.keys(record).filter(isHex64);
  const extra = readExtra(record, 'content', [], pubkeys);
  const labels: Record<string, SubmitterLabel> = {};
  for (const pubkey of pubkeys) {
    const path = `content.${pubkey}`;
    const item = readRecord(record[pubkey], path);
    const itemExtra = readExtra(item, path, LABEL_KEYS, LABEL_KEYS);
    const label: SubmitterLabel = {
      label: readString(item.label, `${path}.label`),
      authorized_at: readInteger(item.authorized_at, `${path}.authorized_at`, { min: 0 }),
    };
    if (itemExtra !== undefined) label.extra = itemExtra;
    labels[pubkey] = label;
  }
  return { labels, extra };
}

function writeLabels(labels: Record<string, SubmitterLabel>, extra?: JsonObject): JsonObject {
  for (const key of Object.keys(extra ?? {})) {
    if (isHex64(key)) throw new Error(`extra key ${key} would read as a pubkey`);
  }
  const entries = Object.entries(labels).map(([pubkey, l]): [string, JsonValue] => [
    pubkey,
    withExtra(
      [
        ['label', l.label],
        ['authorized_at', l.authorized_at],
      ],
      l.extra,
      LABEL_KEYS
    ),
  ]);
  return withExtra(entries, extra, Object.keys(labels));
}

function readPublic(event: unknown): SubmittersPublic & { content: string; tags: string[][] } {
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
    tags: signed.tags,
  };
}

/**
 * Builds the submitters list (`KIND_SUBMITTERS`, spec 7.3): a public `p` tag per agent, so the
 * relay can enforce writes, and the labels NIP-44-encrypted to the queue key.
 */
export async function buildSubmittersList(
  signer: Signer,
  labels: Record<string, SubmitterLabel>,
  options: SubmittersOptions = {}
): Promise<NostrEvent> {
  let wire: JsonObject;
  let extraTags: string[][];
  try {
    wire = writeLabels(labels, options.extra);
    extraTags = checkExtraTags(options.extraTags, ['p']);
  } catch (error) {
    throw new Error(`invalid submitter labels: ${(error as Error).message}`);
  }
  const checked = checkInput('submitter labels', () =>
    readLabels(parseJsonText(JSON.stringify(wire)))
  );
  const pubkey = await signer.getPublicKey();
  return signer.signEvent({
    kind: KIND_SUBMITTERS,
    created_at: options.createdAt ?? Math.floor(Date.now() / 1000),
    tags: [...Object.keys(checked.labels).map((agent) => ['p', agent]), ...extraTags],
    content: await signer.nip44Encrypt(pubkey, JSON.stringify(wire)),
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
    const { content: _content, tags: _tags, ...parsed } = readPublic(event);
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
    const { content, tags, ...parsed } = readPublic(event);
    const owner = await signer.getPublicKey();
    if (parsed.pubkey !== owner)
      throw new Invalid('wrong_author', 'not signed by this key', 'pubkey');
    const { labels, extra } = readLabels(parseJsonText(await decryptWith(signer, owner, content)));
    const labelled = Object.keys(labels);
    if (
      labelled.length !== parsed.submitters.length ||
      !labelled.every((agent) => parsed.submitters.includes(agent))
    ) {
      throw new Invalid('invalid_content', 'labels do not match the p tags', 'content');
    }
    const list: SubmittersList = { ...parsed, labels };
    if (extra !== undefined) list.extra = extra;
    const extraTags = extraTagsOf(tags, ['p']);
    if (extraTags !== undefined) list.extraTags = extraTags;
    return list;
  });
}

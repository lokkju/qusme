import type { NostrEvent } from 'nostr-tools/core';
import { KIND_DELETION, KIND_DRAFT_WRAP, KIND_GIFT_WRAP } from './kinds.ts';
import { capture, checkInput, Invalid, type ParseResult } from './result.ts';
import type { Signer } from './signer.ts';
import { checkKind, isHex64, readSignedEvent } from './validate.ts';

/** What a NIP-09 deletion request names. */
export interface DeletionTargets {
  /** Event ids (`e` tags). */
  eventIds?: string[];
  /** Addresses `<kind>:<pubkey>:<d>` (`a` tags). */
  addresses?: string[];
  /** The kinds being deleted (`k` tags); derived from the addresses when left out. */
  kinds?: number[];
  /** The `content`: an optional reason. */
  reason?: string;
}

export interface DeletionRequest {
  id: string;
  pubkey: string;
  createdAt: number;
  eventIds: string[];
  addresses: string[];
  kinds: number[];
  reason: string;
}

const ADDRESS = /^(0|[1-9]\d{0,4}):([0-9a-f]{64}):(.*)$/s;
const KIND = /^(0|[1-9]\d{0,4})$/;

/** The address of a draft wrap, `31234:<pubkey>:<d>`, as NIP-09 `a` tags and NIP-01 filters use. */
export function draftAddress(pubkey: string, d: string): string {
  return `${KIND_DRAFT_WRAP}:${pubkey}:${d}`;
}

function readAddress(address: string, path: string, author?: string): number {
  const m = ADDRESS.exec(address);
  if (m === null || Number(m[1]) > 65535) throw new Invalid('invalid_tags', 'not an address', path);
  // NIP-09: an `a` tag can only delete the requester's own addressable events.
  if (author !== undefined && m[2] !== author) {
    throw new Invalid('invalid_tags', 'address of another author', path);
  }
  return Number(m[1]);
}

function readDeletion(event: NostrEvent): DeletionRequest {
  checkKind(event.kind, [KIND_DELETION]);
  const result: DeletionRequest = {
    id: event.id,
    pubkey: event.pubkey,
    createdAt: event.created_at,
    eventIds: [],
    addresses: [],
    kinds: [],
    reason: event.content,
  };
  event.tags.forEach((tag, i) => {
    const path = `tags[${i}]`;
    const [name, value] = tag;
    if (name === 'e') {
      if (!isHex64(value)) throw new Invalid('invalid_tags', 'not an event id', path);
      result.eventIds.push(value);
    } else if (name === 'a') {
      readAddress(value ?? '', path, event.pubkey);
      result.addresses.push(value as string);
    } else if (name === 'k') {
      if (value === undefined || !KIND.test(value) || Number(value) > 65535) {
        throw new Invalid('invalid_tags', 'not a kind', path);
      }
      result.kinds.push(Number(value));
    }
  });
  if (result.eventIds.length === 0 && result.addresses.length === 0) {
    throw new Invalid('invalid_tags', 'names no event', 'tags');
  }
  return result;
}

/** Builds a NIP-09 deletion request (kind 5) signed by `signer`. */
export async function buildDeletionRequest(
  signer: Signer,
  targets: DeletionTargets,
  options: { createdAt?: number } = {}
): Promise<NostrEvent> {
  const pubkey = await signer.getPublicKey();
  const eventIds = targets.eventIds ?? [];
  const addresses = targets.addresses ?? [];
  const kinds = checkInput('deletion targets', () => {
    for (const id of eventIds)
      if (!isHex64(id)) throw new Invalid('invalid_tags', 'not an event id', 'eventIds');
    const fromAddresses = addresses.map((a, i) => readAddress(a, `addresses[${i}]`, pubkey));
    if (eventIds.length === 0 && addresses.length === 0) {
      throw new Invalid('invalid_tags', 'names no event', 'targets');
    }
    return targets.kinds ?? [...new Set(fromAddresses)];
  });
  return signer.signEvent({
    kind: KIND_DELETION,
    created_at: options.createdAt ?? Math.floor(Date.now() / 1000),
    tags: [
      ...eventIds.map((id) => ['e', id]),
      ...addresses.map((a) => ['a', a]),
      ...kinds.map((k) => ['k', String(k)]),
    ],
    content: targets.reason ?? '',
  });
}

/**
 * The deletion request a device sends for gift wraps it has ingested (spec 11.4). NIP-59 lets the
 * `p`-tagged recipient request it.
 */
export async function buildGiftWrapDeletion(
  signer: Signer,
  wrapIds: string[],
  options: { createdAt?: number } = {}
): Promise<NostrEvent> {
  return buildDeletionRequest(signer, { eventIds: wrapIds, kinds: [KIND_GIFT_WRAP] }, options);
}

/** Parses an untrusted NIP-09 deletion request; `a` tags must name the requester's own events. */
export function parseDeletionRequest(event: unknown): ParseResult<DeletionRequest> {
  return capture(() => readDeletion(readSignedEvent(event)));
}

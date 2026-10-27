import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import type { EventTemplate, NostrEvent } from 'nostr-tools/core';
import { buildDeletionRequest, draftAddress } from './deletion.ts';
import { type FieldValue, fieldValueRumor, readFieldValue, readRumor } from './fieldValue.ts';
import { FIELD_VALUE_KINDS, KIND_DRAFT_WRAP, KIND_FIELD_VALUE, KIND_SHORT_NOTE } from './kinds.ts';
import { captureAsync, checkInput, Invalid, type ParseResult } from './result.ts';
import type { Signer } from './signer.ts';
import {
  checkKind,
  decryptWith,
  isHex64,
  parseJsonText,
  readSignedEvent,
  singleTag,
} from './validate.ts';

/** An unsigned kind 1 note held as a draft (spec 2.2): any NIP-37 client can read it. */
export interface NoteDraft {
  createdAt: number;
  tags: string[][];
  content: string;
}

export type DraftContent =
  | { type: 'field_value'; value: FieldValue }
  | { type: 'note'; note: NoteDraft };

interface WrapMeta {
  /** The wrap event's id. */
  id: string;
  /** The queue pubkey that signed the wrap. */
  pubkey: string;
  d: string;
  /** The wrap's `created_at`: when it was last republished. */
  createdAt: number;
}

export interface DraftWrap extends WrapMeta {
  deleted: false;
  draft: DraftContent;
}

/** A blanked wrap: NIP-37's signal that the draft was deleted. */
export interface DeletedDraftWrap extends WrapMeta {
  deleted: true;
}

const INGEST_PREFIX = 'qus.me/submission:';
const D_MAX = 256;

/**
 * The `d` tag of the draft ingested from a submission (spec 11.4): the lowercase hex SHA-256 of
 * the UTF-8 string `qus.me/submission:` followed by the gift wrap id in lowercase hex. Every
 * device derives the same `d`, so concurrent ingestion converges on one addressable event.
 */
export function ingestedDraftD(wrapId: string): string {
  const id = wrapId.toLowerCase();
  if (!isHex64(id)) throw new Error('gift wrap id must be 64 hex characters');
  return bytesToHex(sha256(utf8ToBytes(INGEST_PREFIX + id)));
}

/**
 * A `d` for a draft created on a device: 16 random bytes as 32 hex characters, which never has
 * the 64-hex form that {@link ingestedDraftD} produces.
 */
export function newDraftId(): string {
  return bytesToHex(randomBytes(16));
}

function checkD(d: string): void {
  if (d.length === 0 || d.length > D_MAX)
    throw new Error(`draft d must be 1 to ${D_MAX} characters`);
}

function draftRumor(draft: DraftContent): EventTemplate {
  if (draft.type === 'field_value') return fieldValueRumor(draft.value);
  return checkInput('note draft', () => {
    const template = {
      kind: KIND_SHORT_NOTE,
      created_at: draft.note.createdAt,
      tags: draft.note.tags.map((tag) => [...tag]),
      content: draft.note.content,
    };
    readRumor(template);
    return template;
  });
}

/**
 * Builds a draft wrap (kind 31234): `d`, `k`, and the draft rumor NIP-44-encrypted to the
 * signer's own key (spec 7.1). Editing a draft is building it again with the same `d`. No
 * expiration: drafts last until archived and deleted.
 */
export async function buildDraftWrap(
  signer: Signer,
  input: { d: string; draft: DraftContent; createdAt?: number }
): Promise<NostrEvent> {
  checkD(input.d);
  const rumor = draftRumor(input.draft);
  const pubkey = await signer.getPublicKey();
  return signer.signEvent({
    kind: KIND_DRAFT_WRAP,
    created_at: input.createdAt ?? Math.floor(Date.now() / 1000),
    tags: [
      ['d', input.d],
      ['k', String(rumor.kind)],
    ],
    content: await signer.nip44Encrypt(pubkey, JSON.stringify(rumor)),
  });
}

/**
 * Deletes a draft (spec 7.1): a blanked wrap with the same `d` and a NIP-09 request naming its
 * address. Publish both; the user's own relay hard-deletes.
 */
export async function buildDraftDeletion(
  signer: Signer,
  input: { d: string; kind?: number; createdAt?: number }
): Promise<{ blanked: NostrEvent; deletion: NostrEvent }> {
  checkD(input.d);
  const pubkey = await signer.getPublicKey();
  const createdAt = input.createdAt ?? Math.floor(Date.now() / 1000);
  const blanked = await signer.signEvent({
    kind: KIND_DRAFT_WRAP,
    created_at: createdAt,
    tags: [
      ['d', input.d],
      ['k', String(input.kind ?? KIND_FIELD_VALUE)],
    ],
    content: '',
  });
  const deletion = await buildDeletionRequest(
    signer,
    { addresses: [draftAddress(pubkey, input.d)], kinds: [KIND_DRAFT_WRAP] },
    { createdAt }
  );
  return { blanked, deletion };
}

const DRAFT_KINDS = [...FIELD_VALUE_KINDS, KIND_SHORT_NOTE];

/**
 * Parses an untrusted draft wrap and decrypts it with `signer`, which must hold the key that
 * signed it. `k` must be a field value kind (current or former) or 1, and match the rumor.
 */
export function parseDraftWrap(
  event: unknown,
  signer: Signer
): Promise<ParseResult<DraftWrap | DeletedDraftWrap>> {
  return captureAsync(async () => {
    const signed = readSignedEvent(event);
    checkKind(signed.kind, [KIND_DRAFT_WRAP]);
    const owner = await signer.getPublicKey();
    if (signed.pubkey !== owner)
      throw new Invalid('wrong_author', 'not signed by this key', 'pubkey');
    const d = singleTag(signed.tags, 'd', true);
    if (d.length === 0 || d.length > D_MAX) throw new Invalid('invalid_tags', 'bad d', 'tags.d');
    const k = singleTag(signed.tags, 'k', true);
    if (!DRAFT_KINDS.map(String).includes(k)) {
      throw new Invalid('invalid_tags', `k ${k} is not a field value or note`, 'tags.k');
    }
    const meta: WrapMeta = {
      id: signed.id,
      pubkey: signed.pubkey,
      d,
      createdAt: signed.created_at,
    };
    if (signed.content === '') return { ...meta, deleted: true };

    const json = parseJsonText(await decryptWith(signer, owner, signed.content), 'rumor');
    const rumor = readRumor(json);
    if (String(rumor.kind) !== k)
      throw new Invalid('invalid_tags', 'k differs from the rumor kind', 'tags.k');
    if (rumor.pubkey !== undefined && rumor.pubkey !== owner) {
      throw new Invalid('invalid_content', 'rumor pubkey differs from the wrap', 'rumor.pubkey');
    }
    const draft: DraftContent =
      rumor.kind === KIND_SHORT_NOTE
        ? {
            type: 'note',
            note: { createdAt: rumor.createdAt, tags: rumor.tags, content: rumor.content },
          }
        : { type: 'field_value', value: readFieldValue(json) };
    return { ...meta, deleted: false, draft };
  });
}

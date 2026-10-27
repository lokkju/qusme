import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { v2 } from 'nostr-tools/nip44';
import { verifyEvent } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import {
  buildDraftDeletion,
  buildDraftWrap,
  draftAddress,
  fieldValueRumor,
  ingestedDraftD,
  KIND_DELETION,
  KIND_DRAFT_WRAP,
  KIND_FIELD_VALUE,
  KIND_SHORT_NOTE,
  newDraftId,
  nip44Encrypt,
  parseDeletionRequest,
  parseDraftWrap,
} from '../src/index.ts';
import {
  exampleValue,
  expectError,
  expectOk,
  NOW,
  other,
  queue,
  queueKey,
  queuePubkey,
  sign,
  tamper,
  WRAP_ID,
} from './helpers.ts';

const encryptToQueue = (value: unknown) =>
  nip44Encrypt(queueKey, queuePubkey, JSON.stringify(value));

describe('draft wraps (NIP-37)', () => {
  it('round-trips a field value draft', async () => {
    const wrap = await buildDraftWrap(queue, {
      d: 'draft-1',
      draft: { type: 'field_value', value: exampleValue },
      createdAt: NOW,
    });
    expect(wrap.kind).toBe(KIND_DRAFT_WRAP);
    expect(wrap.tags).toEqual([
      ['d', 'draft-1'],
      ['k', String(KIND_FIELD_VALUE)],
    ]);
    expect(wrap.tags.find((t) => t[0] === 'expiration')).toBeUndefined();
    const parsed = expectOk(await parseDraftWrap(JSON.parse(JSON.stringify(wrap)), queue));
    expect(parsed).toEqual({
      id: wrap.id,
      pubkey: queuePubkey,
      d: 'draft-1',
      createdAt: NOW,
      deleted: false,
      draft: { type: 'field_value', value: exampleValue },
    });
  });

  it('round-trips a kind 1 note draft', async () => {
    const note = { createdAt: NOW, tags: [['t', 'nostr']], content: 'gm' };
    const wrap = await buildDraftWrap(queue, { d: 'n', draft: { type: 'note', note } });
    expect(wrap.tags).toContainEqual(['k', String(KIND_SHORT_NOTE)]);
    const parsed = expectOk(await parseDraftWrap(wrap, queue));
    expect(parsed.deleted || parsed.draft).toEqual({ type: 'note', note });
  });

  it('produces events nostr-tools verifies, with content nostr-tools decrypts', async () => {
    const wrap = await buildDraftWrap(queue, {
      d: 'x',
      draft: { type: 'field_value', value: exampleValue },
    });
    expect(verifyEvent({ ...wrap })).toBe(true);
    const key = v2.utils.getConversationKey(queueKey, queuePubkey);
    expect(JSON.parse(v2.decrypt(wrap.content, key))).toEqual(fieldValueRumor(exampleValue));
  });

  it('edits by rebuilding under the same d', async () => {
    const first = await buildDraftWrap(queue, {
      d: 'same',
      draft: { type: 'field_value', value: exampleValue },
    });
    const edited = await buildDraftWrap(queue, {
      d: 'same',
      draft: { type: 'field_value', value: { ...exampleValue, content: 'edited' } },
    });
    const a = expectOk(await parseDraftWrap(first, queue));
    const b = expectOk(await parseDraftWrap(edited, queue));
    expect(a.d).toBe(b.d);
    expect(!b.deleted && b.draft.type === 'field_value' && b.draft.value.content).toBe('edited');
  });

  it('deletes with a blanked wrap and a NIP-09 request', async () => {
    const { blanked, deletion } = await buildDraftDeletion(queue, { d: 'gone', createdAt: NOW });
    expect(blanked.content).toBe('');
    expect(expectOk(await parseDraftWrap(blanked, queue))).toEqual({
      id: blanked.id,
      pubkey: queuePubkey,
      d: 'gone',
      createdAt: NOW,
      deleted: true,
    });
    expect(deletion.kind).toBe(KIND_DELETION);
    expect(verifyEvent({ ...deletion })).toBe(true);
    const request = expectOk(parseDeletionRequest(deletion));
    expect(request.addresses).toEqual([draftAddress(queuePubkey, 'gone')]);
    expect(request.kinds).toEqual([KIND_DRAFT_WRAP]);
  });

  it('rejects a k that is not a field value kind or 1', async () => {
    const wrap = sign({
      kind: KIND_DRAFT_WRAP,
      created_at: NOW,
      tags: [
        ['d', 'x'],
        ['k', '30023'],
      ],
      content: encryptToQueue({ kind: 30023, created_at: NOW, tags: [], content: '' }),
    });
    expectError(await parseDraftWrap(wrap, queue), 'invalid_tags');
  });

  it('rejects a k that differs from the rumor kind', async () => {
    const wrap = sign({
      kind: KIND_DRAFT_WRAP,
      created_at: NOW,
      tags: [
        ['d', 'x'],
        ['k', String(KIND_SHORT_NOTE)],
      ],
      content: encryptToQueue(fieldValueRumor(exampleValue)),
    });
    expectError(await parseDraftWrap(wrap, queue), 'invalid_tags');
  });

  it('rejects missing d or k, wrong kind, bad signature, other author, undecryptable content', async () => {
    const rumor = fieldValueRumor(exampleValue);
    const good = await buildDraftWrap(queue, {
      d: 'x',
      draft: { type: 'field_value', value: exampleValue },
    });
    const noK = sign({
      kind: KIND_DRAFT_WRAP,
      created_at: NOW,
      tags: [['d', 'x']],
      content: encryptToQueue(rumor),
    });
    const noD = sign({
      kind: KIND_DRAFT_WRAP,
      created_at: NOW,
      tags: [['k', String(KIND_FIELD_VALUE)]],
      content: encryptToQueue(rumor),
    });
    expectError(await parseDraftWrap(noK, queue), 'invalid_tags');
    expectError(await parseDraftWrap(noD, queue), 'invalid_tags');
    expectError(
      await parseDraftWrap(tamper(good, { content: `${good.content}x` }), queue),
      'bad_signature'
    );
    expectError(await parseDraftWrap(good, other), 'wrong_author');
    const garbage = sign({
      kind: KIND_DRAFT_WRAP,
      created_at: NOW,
      tags: good.tags,
      content: 'AgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    });
    expectError(await parseDraftWrap(garbage, queue), 'decrypt_failed');
    const notJson = sign({
      kind: KIND_DRAFT_WRAP,
      created_at: NOW,
      tags: good.tags,
      content: nip44Encrypt(queueKey, queuePubkey, 'not json'),
    });
    expectError(await parseDraftWrap(notJson, queue), 'invalid_json');
    const wrongKind = sign({ ...rumor, kind: KIND_DELETION, tags: [['e', WRAP_ID]] });
    expectError(await parseDraftWrap(wrongKind, queue), 'wrong_kind');
    for (const value of [null, {}, 'event', { ...good, tags: [[1]] }]) {
      expectError(await parseDraftWrap(value, queue), 'not_an_event');
    }
  });

  it('rejects a rumor whose own fields are malformed, including prototype keys', async () => {
    const rumor = fieldValueRumor(exampleValue);
    for (const inner of [
      { ...rumor, tags: rumor.tags.filter((t) => t[0] !== 'status') },
      { ...rumor, sig: 'f'.repeat(128) },
      JSON.parse(`{"__proto__":{"polluted":true},"kind":${KIND_FIELD_VALUE}}`),
    ]) {
      const wrap = sign({
        kind: KIND_DRAFT_WRAP,
        created_at: NOW,
        tags: [
          ['d', 'x'],
          ['k', String(KIND_FIELD_VALUE)],
        ],
        content: encryptToQueue(inner),
      });
      expect((await parseDraftWrap(wrap, queue)).ok).toBe(false);
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('ingested draft d (spec 11.4)', () => {
  it('is the hex SHA-256 of "qus.me/submission:" and the lowercase wrap id', () => {
    const wrapId = '0123456789abcdef'.repeat(4);
    const expected = bytesToHex(sha256(utf8ToBytes(`qus.me/submission:${wrapId}`)));
    expect(ingestedDraftD(wrapId)).toBe(expected);
    expect(ingestedDraftD(wrapId.toUpperCase())).toBe(expected);
    expect(ingestedDraftD(wrapId)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('pins one known value, for other implementations to check against', () => {
    expect(ingestedDraftD('0'.repeat(64))).toBe(
      bytesToHex(sha256(utf8ToBytes(`qus.me/submission:${'0'.repeat(64)}`)))
    );
    expect(ingestedDraftD('0'.repeat(64))).toMatchInlineSnapshot(
      `"14455af4b9fefa49e50a4e707a0c0cc28b9bb516cc393a7e03beab9d551d1a0c"`
    );
  });

  it('refuses a wrap id that is not 64 hex characters', () => {
    expect(() => ingestedDraftD('abc')).toThrow();
  });

  it('never collides in form with a device-created id', () => {
    expect(newDraftId()).toMatch(/^[0-9a-f]{32}$/);
    expect(newDraftId()).not.toBe(newDraftId());
  });
});

import { verifyEvent } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import {
  buildDeletionRequest,
  draftAddress,
  KIND_DELETION,
  KIND_DRAFT_WRAP,
  parseDeletionRequest,
} from '../src/index.ts';
import {
  expectError,
  expectOk,
  NOW,
  otherPubkey,
  queue,
  queuePubkey,
  sign,
  WRAP_ID,
} from './helpers.ts';

describe('NIP-09 deletion requests', () => {
  it('round-trips event ids, addresses, derived kinds and a reason', async () => {
    const event = await buildDeletionRequest(
      queue,
      { eventIds: [WRAP_ID], addresses: [draftAddress(queuePubkey, 'a')], reason: 'dismissed' },
      { createdAt: NOW }
    );
    expect(event.kind).toBe(KIND_DELETION);
    expect(event.tags).toEqual([
      ['e', WRAP_ID],
      ['a', `${KIND_DRAFT_WRAP}:${queuePubkey}:a`],
      ['k', String(KIND_DRAFT_WRAP)],
    ]);
    expect(verifyEvent({ ...event })).toBe(true);
    expect(expectOk(parseDeletionRequest(event))).toEqual({
      id: event.id,
      pubkey: queuePubkey,
      createdAt: NOW,
      eventIds: [WRAP_ID],
      addresses: [draftAddress(queuePubkey, 'a')],
      kinds: [KIND_DRAFT_WRAP],
      reason: 'dismissed',
    });
  });

  it("refuses to build a request naming nothing, or another author's address", async () => {
    await expect(buildDeletionRequest(queue, {})).rejects.toThrow();
    await expect(
      buildDeletionRequest(queue, { addresses: [draftAddress(otherPubkey, 'a')] })
    ).rejects.toThrow();
    await expect(buildDeletionRequest(queue, { eventIds: ['x'] })).rejects.toThrow();
  });

  it('rejects malformed requests', () => {
    const base = { kind: KIND_DELETION, created_at: NOW, content: '' };
    for (const tags of [
      [],
      [['e', 'nothex']],
      [['a', `${KIND_DRAFT_WRAP}:${otherPubkey}:a`]],
      [['a', 'garbage']],
      [
        ['e', WRAP_ID],
        ['k', 'five'],
      ],
    ]) {
      expectError(parseDeletionRequest(sign({ ...base, tags })), 'invalid_tags');
    }
    expectError(
      parseDeletionRequest(sign({ ...base, kind: KIND_DRAFT_WRAP, tags: [['e', WRAP_ID]] })),
      'wrong_kind'
    );
  });
});

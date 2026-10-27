import {
  createRumor as ntRumor,
  createSeal as ntSeal,
  unwrapEvent,
  wrapEvent,
} from 'nostr-tools/nip59';
import { verifyEvent } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import {
  buildDraftWrap,
  buildGiftWrapDeletion,
  buildSubmission,
  createGiftWrap,
  fieldValueFromSubmission,
  giftWrap,
  ingestedDraftD,
  KIND_FIELD_VALUE,
  KIND_GIFT_WRAP,
  openSubmission,
  parseDeletionRequest,
  parseDraftWrap,
} from '../src/index.ts';
import {
  agent,
  agentKey,
  agentPubkey,
  DAY,
  expectError,
  expectOk,
  NOW,
  other,
  otherPubkey,
  queue,
  queueKey,
  queuePubkey,
} from './helpers.ts';

const value = {
  site: 'x',
  account: 'lokkju',
  field: 'text',
  content: 'from an agent',
  createdAt: NOW,
};

describe('submissions (spec 7.5)', () => {
  it('round-trips through seal and gift wrap with a 30-day expiration by default', async () => {
    const wrap = await buildSubmission(agent, queuePubkey, value, { now: NOW });
    expect(wrap.kind).toBe(KIND_GIFT_WRAP);
    expect(wrap.tags).toEqual([
      ['p', queuePubkey],
      ['expiration', String(NOW + 30 * DAY)],
    ]);
    const opened = expectOk(await openSubmission(JSON.parse(JSON.stringify(wrap)), queue));
    expect(opened.wrapId).toBe(wrap.id);
    expect(opened.submitter).toBe(agentPubkey);
    expect(opened.expiration).toBe(NOW + 30 * DAY);
    expect(opened.value).toEqual({ ...value, reserved: [] });
  });

  it('takes the grant expiration and refuses more than 90 days', async () => {
    const wrap = await buildSubmission(agent, queuePubkey, value, {
      now: NOW,
      submissionExpirationDays: 7,
    });
    expect(expectOk(await openSubmission(wrap, queue)).expiration).toBe(NOW + 7 * DAY);
    await expect(
      buildSubmission(agent, queuePubkey, value, { submissionExpirationDays: 91 })
    ).rejects.toThrow();
    await expect(
      buildSubmission(agent, queuePubkey, value, { submissionExpirationDays: 0 })
    ).rejects.toThrow();
  });

  it('produces a wrap nostr-tools verifies and unwraps', async () => {
    const wrap = await buildSubmission(agent, queuePubkey, value, { now: NOW });
    expect(verifyEvent({ ...wrap })).toBe(true);
    const rumor = unwrapEvent(wrap, queueKey);
    expect(rumor.kind).toBe(KIND_FIELD_VALUE);
    expect(rumor.pubkey).toBe(agentPubkey);
    expect(rumor.content).toBe('from an agent');
  });

  it('opens a rumor and seal made by nostr-tools', async () => {
    const rumorEvent = {
      kind: KIND_FIELD_VALUE,
      created_at: NOW,
      content: 'via nostr-tools',
      tags: [
        ['site', 'x'],
        ['account', 'lokkju'],
        ['field', 'text'],
      ],
    };
    const seal = ntSeal(ntRumor(rumorEvent, agentKey), agentKey, queuePubkey);
    const wrap = createGiftWrap(seal, queuePubkey, { expiration: NOW + DAY, now: NOW });
    const opened = expectOk(await openSubmission(wrap, queue));
    expect(opened.submitter).toBe(agentPubkey);
    expect(opened.value.content).toBe('via nostr-tools');
    // nostr-tools' own wrap has no expiration; the queue refuses it, as spec 7.5 requires one.
    expectError(
      await openSubmission(wrapEvent(rumorEvent, agentKey, queuePubkey), queue),
      'invalid_tags'
    );
  });

  it('rejects state tags in a submission rumor', async () => {
    const wrap = await giftWrap(
      {
        kind: KIND_FIELD_VALUE,
        created_at: NOW,
        content: 'x',
        tags: [
          ['site', 'x'],
          ['account', 'lokkju'],
          ['field', 'text'],
          ['status', 'archived:inserted'],
        ],
      },
      agent,
      queuePubkey,
      { now: NOW, expiration: NOW + DAY }
    );
    expectError(await openSubmission(wrap, queue), 'invalid_tags');
  });

  it('rejects a wrap for another queue, without expiration, or of the wrong kind', async () => {
    const forOther = await buildSubmission(agent, otherPubkey, value, { now: NOW });
    expectError(await openSubmission(forOther, queue), 'invalid_tags');
    const noExpiry = await giftWrap(
      { kind: KIND_FIELD_VALUE, tags: [['site', 'x']] },
      agent,
      queuePubkey
    );
    expectError(await openSubmission(noExpiry, queue), 'invalid_tags');
    const draft = await buildDraftWrap(queue, {
      d: 'x',
      draft: { type: 'note', note: { createdAt: NOW, tags: [], content: '' } },
    });
    expectError(await openSubmission(draft, queue), 'wrong_kind');
    const sealedForOther = ntSeal(
      ntRumor({ ...value, kind: KIND_FIELD_VALUE, created_at: NOW, tags: [] }, agentKey),
      agentKey,
      otherPubkey
    );
    const misaddressed = createGiftWrap(sealedForOther, queuePubkey, {
      now: NOW,
      expiration: NOW + DAY,
    });
    expectError(await openSubmission(misaddressed, queue), 'unwrap_failed');
    expectError(
      await openSubmission(await buildSubmission(agent, queuePubkey, value), other),
      'invalid_tags'
    );
    expectError(await openSubmission('nope', queue), 'not_an_event');
  });

  it('ingests into an active draft under the derived d, then deletes the wrap', async () => {
    const wrap = await buildSubmission(agent, queuePubkey, value, { now: NOW });
    const submission = expectOk(await openSubmission(wrap, queue));
    const draftValue = fieldValueFromSubmission(submission, '01JA');
    expect(draftValue).toMatchObject({
      status: 'active',
      destination: '01JA',
      source: { wrapId: wrap.id, submitter: agentPubkey },
      inserted: [],
    });
    const d = ingestedDraftD(submission.wrapId);
    const draft = await buildDraftWrap(queue, {
      d,
      draft: { type: 'field_value', value: draftValue },
    });
    expect(draft.tags.some((t) => t[0] === 'expiration')).toBe(false);
    const parsed = expectOk(await parseDraftWrap(draft, queue));
    expect(parsed.d).toBe(d);
    expect(!parsed.deleted && parsed.draft).toEqual({ type: 'field_value', value: draftValue });

    const deletion = await buildGiftWrapDeletion(queue, [wrap.id]);
    expect(expectOk(parseDeletionRequest(deletion))).toMatchObject({
      eventIds: [wrap.id],
      kinds: [KIND_GIFT_WRAP],
    });
  });
});

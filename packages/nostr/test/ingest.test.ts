import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import {
  type AgentGrant,
  buildSubmission,
  createLocalSigner,
  type Destination,
  INGEST_CAP,
  INGEST_LOOKBACK_SECONDS,
  type IngestInput,
  inboxSince,
  ingestedDraftD,
  ingestSubmissions,
  mergeDestinations,
  mergeQuotaCounts,
  type NostrEvent,
  pendingDestinationId,
  powOf,
  quotaPeriodStart,
  retiredInboxDrainEnd,
  type Signer,
  type SubmissionInput,
} from '../src/index.ts';
import { agent, agentPubkey, DAY, NOW, other, otherPubkey } from './helpers.ts';

const inboxKey = generateSecretKey();
const inboxPubkey = getPublicKey(inboxKey);

/** A signer that records the peer of every decryption, to prove which layers were opened. */
function counting(key: Uint8Array): Signer & { peers: string[] } {
  const inner = createLocalSigner(key);
  const peers: string[] = [];
  return {
    peers,
    getPublicKey: () => inner.getPublicKey(),
    signEvent: (t) => inner.signEvent(t),
    nip44Encrypt: (p, x) => inner.nip44Encrypt(p, x),
    nip44Decrypt: (peer, payload) => {
      peers.push(peer);
      return inner.nip44Decrypt(peer, payload);
    },
  };
}

const grant = (over: Partial<AgentGrant> = {}): AgentGrant => ({
  inbox: ['wss://inbox.example/'],
  inbox_pubkey: inboxPubkey,
  min_pow: 0,
  destinations: [{ site: 'x', account: 'lokkju', fields: ['text'] }],
  allow_new_destinations: false,
  submission_expiration_days: 30,
  quota: { max_submissions: 50, period: 'day' },
  expires_at: null,
  ...over,
});

const confirmed: Destination = {
  id: 'dest-x',
  site: 'x',
  account: 'lokkju',
  label: 'X / lokkju',
  status: 'confirmed',
  override: null,
};

const value = (over: Partial<SubmissionInput> = {}): SubmissionInput => ({
  site: 'x',
  account: 'lokkju',
  field: 'text',
  content: 'hello from an agent',
  createdAt: NOW,
  ...over,
});

const submit = (
  over: Partial<SubmissionInput> = {},
  options: { pow?: number; by?: Signer; to?: string } = {}
): Promise<NostrEvent> =>
  buildSubmission(options.by ?? agent, options.to ?? inboxPubkey, value(over), {
    now: NOW,
    ...(options.pow !== undefined && { pow: options.pow }),
  });

function input(wraps: NostrEvent[], over: Partial<IngestInput> = {}): IngestInput {
  return {
    wraps,
    inboxes: [createLocalSigner(inboxKey)],
    existingDraftDs: new Set(),
    submitters: new Set([agentPubkey]),
    grants: new Map([[agentPubkey, grant()]]),
    destinations: [confirmed],
    quotaCounts: {},
    now: NOW,
    ...over,
  };
}

describe('ingestion (spec 11.4)', () => {
  it('turns a submission into an active draft with a derived d, source and destination', async () => {
    const wrap = await submit();
    const out = await ingestSubmissions(input([wrap]));
    expect(out.discarded).toEqual([]);
    expect(out.drafts).toHaveLength(1);
    const [draft] = out.drafts;
    expect(draft?.d).toBe(ingestedDraftD(wrap.id));
    expect(draft?.inboxPubkey).toBe(inboxPubkey);
    expect(draft?.value).toMatchObject({
      status: 'active',
      site: 'x',
      account: 'lokkju',
      field: 'text',
      destination: 'dest-x',
      content: 'hello from an agent',
      source: { wrapId: wrap.id, submitter: agentPubkey },
    });
    expect(out.quotaCounts[agentPubkey]).toEqual({
      period_start: quotaPeriodStart('day', NOW),
      accepted: [wrap.id],
      discarded: [],
    });
    expect(out.quotaChanged).toBe(true);
    expect(out.newDestinations).toEqual([]);
  });

  it('skips a wrap whose derived d exists without decrypting anything', async () => {
    const wrap = await submit();
    const inbox = counting(inboxKey);
    const out = await ingestSubmissions(
      input([wrap, wrap], { inboxes: [inbox], existingDraftDs: new Set([ingestedDraftD(wrap.id)]) })
    );
    expect(out.skipped).toEqual([{ wrapId: wrap.id, inboxPubkey }]);
    expect(out.drafts).toEqual([]);
    expect(inbox.peers).toEqual([]);
  });

  it('skips wraps this device already handled', async () => {
    const wrap = await submit();
    const inbox = counting(inboxKey);
    const out = await ingestSubmissions(
      input([wrap], { inboxes: [inbox], handled: new Set([wrap.id]) })
    );
    expect(out.skipped).toHaveLength(1);
    expect(inbox.peers).toEqual([]);
  });

  it('never decrypts the seal or verifies further for a pubkey off the submitters list', async () => {
    const wrap = await submit({}, { by: other });
    const inbox = counting(inboxKey);
    const out = await ingestSubmissions(input([wrap], { inboxes: [inbox] }));
    expect(out.discarded).toEqual([
      { wrapId: wrap.id, reason: 'unauthorized_submitter', inboxPubkey },
    ]);
    expect(out.drafts).toEqual([]);
    // One decryption, of the gift wrap layer (peer: its ephemeral key); none with the sender.
    expect(inbox.peers).toEqual([wrap.pubkey]);
    expect(inbox.peers).not.toContain(otherPubkey);
    expect(out.quotaChanged).toBe(false);
  });

  it('discards a wrap below every grant’s min_pow before any decryption', async () => {
    const weak = await submit();
    const inbox = counting(inboxKey);
    const grants = new Map([[agentPubkey, grant({ min_pow: 12 })]]);
    const out = await ingestSubmissions(input([weak], { inboxes: [inbox], grants }));
    expect(powOf(weak.id)).toBeLessThan(12);
    expect(out.discarded.map((d) => d.reason)).toEqual(['insufficient_pow']);
    expect(inbox.peers).toEqual([]);
  });

  it('accepts enough work and checks the agent’s own min_pow after unwrapping', async () => {
    const mined = await submit({}, { pow: 8 });
    const grants = new Map([
      [agentPubkey, grant({ min_pow: 8 })],
      [otherPubkey, grant({ min_pow: 0 })],
    ]);
    const ok = await ingestSubmissions(input([mined], { grants }));
    expect(ok.drafts).toHaveLength(1);

    // With another grant at 0 the pre-check is off, so the agent's own 12 bits catch it later.
    const strict = new Map([
      [agentPubkey, grant({ min_pow: 24 })],
      [otherPubkey, grant({ min_pow: 0 })],
    ]);
    const inbox = counting(inboxKey);
    const late = await ingestSubmissions(input([mined], { grants: strict, inboxes: [inbox] }));
    expect(late.discarded.map((d) => d.reason)).toEqual(['insufficient_pow']);
    expect(inbox.peers.length).toBeGreaterThan(1);
  });

  it('opens at most the cap per sync and leaves the rest on the relay', async () => {
    expect(INGEST_CAP).toBe(100);
    const wraps = await Promise.all([1, 2, 3, 4, 5].map((i) => submit({ content: `n${i}` })));
    const inbox = counting(inboxKey);
    const out = await ingestSubmissions(input(wraps, { inboxes: [inbox], cap: 2 }));
    expect(out.drafts).toHaveLength(2);
    expect(out.deferred).toHaveLength(3);
    // Two wraps opened, each with two decryptions (wrap, seal); the deferred ones untouched.
    expect(inbox.peers).toHaveLength(4);
    const deferred = new Set(out.deferred.map((w) => w.wrapId));
    for (const draft of out.drafts) expect(deferred.has(draft.wrapId)).toBe(false);
  });

  it('defers the same wraps whatever order the relays returned them in', async () => {
    const wraps = await Promise.all([1, 2, 3].map((i) => submit({ content: `n${i}` })));
    const a = await ingestSubmissions(input(wraps, { cap: 1 }));
    const b = await ingestSubmissions(input([...wraps].reverse(), { cap: 1 }));
    expect(a.drafts.map((d) => d.wrapId)).toEqual(b.drafts.map((d) => d.wrapId));
  });

  it('discards wraps not addressed to a drained inbox key', async () => {
    const stray = await submit({}, { to: otherPubkey });
    const out = await ingestSubmissions(input([stray]));
    expect(out.discarded).toEqual([{ wrapId: stray.id, reason: 'not_addressed' }]);
  });

  it('opens wraps to a retired inbox key that is still draining', async () => {
    const retiredKey = generateSecretKey();
    const wrap = await submit({}, { to: getPublicKey(retiredKey) });
    const out = await ingestSubmissions(
      input([wrap], { inboxes: [createLocalSigner(inboxKey), createLocalSigner(retiredKey)] })
    );
    expect(out.drafts[0]?.inboxPubkey).toBe(getPublicKey(retiredKey));
  });

  it('enforces the grant: no grant, expired, destination and field not granted', async () => {
    const wraps = {
      expired: await submit({ content: 'a' }),
      dest: await submit({ site: 'mastodon', account: 'me@example.social' }),
      field: await submit({ field: 'reply' }),
    };
    const noGrant = await ingestSubmissions(input([wraps.expired], { grants: new Map() }));
    expect(noGrant.discarded.map((d) => d.reason)).toEqual(['no_grant']);
    const expired = await ingestSubmissions(
      input([wraps.expired], { grants: new Map([[agentPubkey, grant({ expires_at: NOW - 1 })]]) })
    );
    expect(expired.discarded.map((d) => d.reason)).toEqual(['grant_expired']);
    const out = await ingestSubmissions(input([wraps.dest, wraps.field]));
    expect(out.discarded.map((d) => d.reason).sort()).toEqual([
      'destination_not_granted',
      'field_not_granted',
    ]);
    expect(out.discarded.every((d) => d.submitter === agentPubkey)).toBe(true);
    expect(out.quotaChanged).toBe(false);
  });

  it('refuses content over 32 KiB and rumors from the future', async () => {
    const big = await submit({ content: 'x'.repeat(32_769) });
    const future = await submit({ createdAt: NOW + 3600 });
    const out = await ingestSubmissions(input([big, future]));
    expect(out.discarded.map((d) => d.reason).sort()).toEqual(['future_timestamp', 'too_large']);
  });

  it('creates one pending destination, with an id every device derives the same', async () => {
    const grants = new Map([[agentPubkey, grant({ allow_new_destinations: true })]]);
    const a = await submit({ site: 'mastodon', account: 'me@example.social', content: '1' });
    const b = await submit({ site: 'mastodon', account: 'me@example.social', content: '2' });
    const out = await ingestSubmissions(input([a, b], { grants }));
    const id = pendingDestinationId('mastodon', 'me@example.social');
    expect(out.newDestinations).toEqual([
      {
        id,
        site: 'mastodon',
        account: 'me@example.social',
        label: 'mastodon / me@example.social',
        status: 'pending',
        override: null,
      },
    ]);
    expect(out.destinations.map((d) => d.id)).toEqual(['dest-x', id]);
    expect(out.drafts.map((d) => d.value.destination)).toEqual([id, id]);
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(pendingDestinationId('mastodon', 'other')).not.toBe(id);
  });

  it('carries the grant’s override onto a pending destination it names', async () => {
    const override = { match: ['https://x.example/*'] };
    const grants = new Map([
      [
        agentPubkey,
        grant({ destinations: [{ site: 'x', account: 'alt', fields: ['text'], override }] }),
      ],
    ]);
    const out = await ingestSubmissions(input([await submit({ account: 'alt' })], { grants }));
    expect(out.newDestinations[0]?.override).toEqual(override);
  });
});

describe('quota at ingestion (spec 11.4)', () => {
  const quota2 = new Map([[agentPubkey, grant({ quota: { max_submissions: 2, period: 'day' } })]]);

  it('accepts up to the quota and counts the rest as discarded', async () => {
    const wraps = await Promise.all([1, 2, 3].map((i) => submit({ content: `q${i}` })));
    const out = await ingestSubmissions(input(wraps, { grants: quota2 }));
    expect(out.drafts).toHaveLength(2);
    expect(out.discarded.map((d) => d.reason)).toEqual(['over_quota']);
    const count = out.quotaCounts[agentPubkey];
    expect(count?.accepted).toHaveLength(2);
    expect(count?.discarded).toEqual([out.discarded[0]?.wrapId]);
  });

  it('counts what other devices recorded and keeps their decisions', async () => {
    const [mine, theirs] = await Promise.all([submit({ content: 'm' }), submit({ content: 't' })]);
    const start = quotaPeriodStart('day', NOW);
    const recorded = {
      [agentPubkey]: { period_start: start, accepted: ['b'.repeat(64)], discarded: [] },
    };
    // `theirs` was accepted elsewhere but its draft isn't on this relay yet: still accepted.
    const out = await ingestSubmissions(
      input([mine, theirs], {
        grants: quota2,
        quotaCounts: {
          [agentPubkey]: {
            period_start: start,
            accepted: ['b'.repeat(64), theirs.id],
            discarded: [],
          },
        },
      })
    );
    expect(out.drafts.map((d) => d.wrapId)).toEqual([theirs.id]);
    expect(out.discarded.map((d) => [d.wrapId, d.reason])).toEqual([[mine.id, 'over_quota']]);
    const fresh = await ingestSubmissions(input([mine], { grants: quota2, quotaCounts: recorded }));
    expect(fresh.drafts).toHaveLength(1);
  });

  it('starts a new period on a later rumor and counts a backdated one in the recorded period', async () => {
    const start = quotaPeriodStart('day', NOW);
    const full = {
      [agentPubkey]: {
        period_start: start - DAY,
        accepted: ['c'.repeat(64), 'd'.repeat(64)],
        discarded: [],
      },
    };
    const today = await submit({ content: 'today' });
    const out = await ingestSubmissions(input([today], { grants: quota2, quotaCounts: full }));
    expect(out.drafts).toHaveLength(1);
    expect(out.quotaCounts[agentPubkey]).toEqual({
      period_start: start,
      accepted: [today.id],
      discarded: [],
    });

    const current = {
      [agentPubkey]: {
        period_start: start,
        accepted: ['c'.repeat(64), 'd'.repeat(64)],
        discarded: [],
      },
    };
    const backdated = await submit({ createdAt: NOW - 3 * DAY, content: 'old' });
    const late = await ingestSubmissions(
      input([backdated], { grants: quota2, quotaCounts: current })
    );
    expect(late.discarded.map((d) => d.reason)).toEqual(['over_quota']);
  });

  it('merges quota counts by union, the later period winning', () => {
    const p = 1_000;
    const id = (c: string) => c.repeat(64);
    const merged = mergeQuotaCounts(
      {
        a: { period_start: p, accepted: [id('1')], discarded: [id('2')], extra: { keep: true } },
        b: { period_start: p + 10, accepted: [id('3')], discarded: [] },
        c: { period_start: p, accepted: [id('4')], discarded: [] },
      },
      {
        a: { period_start: p, accepted: [id('2'), id('5')], discarded: [id('6')] },
        b: { period_start: p, accepted: [id('7')], discarded: [] },
        d: { period_start: p, accepted: [id('8')], discarded: [] },
      }
    );
    expect(merged).toEqual({
      a: {
        period_start: p,
        accepted: [id('1'), id('2'), id('5')],
        discarded: [id('6')],
        extra: { keep: true },
      },
      b: { period_start: p + 10, accepted: [id('3')], discarded: [] },
      c: { period_start: p, accepted: [id('4')], discarded: [] },
      d: { period_start: p, accepted: [id('8')], discarded: [] },
    });
  });

  it('merges destinations by id, keeping the latest copy', () => {
    const pending = { ...confirmed, id: 'p1', status: 'pending' as const };
    expect(
      mergeDestinations(
        [confirmed, pending],
        [
          { ...pending, label: 'mine' },
          { ...pending, id: 'p2' },
        ]
      )
    ).toEqual([confirmed, pending, { ...pending, id: 'p2' }]);
  });
});

describe('lookback and draining', () => {
  it('queries at least two days before the last sync', () => {
    expect(inboxSince(undefined)).toBeUndefined();
    expect(INGEST_LOOKBACK_SECONDS).toBeGreaterThanOrEqual(2 * DAY);
    expect(inboxSince(NOW)).toBe(NOW - INGEST_LOOKBACK_SECONDS);
    expect(inboxSince(10)).toBe(0);
  });

  it('drains a retired key until the longest grant expiration has passed', () => {
    const retired = { retired_at: NOW };
    expect(retiredInboxDrainEnd(retired, [])).toBe(NOW + 30 * DAY);
    expect(
      retiredInboxDrainEnd(retired, [
        grant({ submission_expiration_days: 7 }),
        grant({ submission_expiration_days: 60 }),
      ])
    ).toBe(NOW + 60 * DAY);
  });
});

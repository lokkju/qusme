import { bytesToHex } from '@noble/hashes/utils.js';
import {
  type AgentGrantInput,
  buildAgentGrant,
  buildDestinations,
  buildSettings,
  buildSubmission,
  buildSubmittersList,
  createLocalSigner,
  D_DESTINATIONS,
  D_SETTINGS,
  INGEST_LOOKBACK_SECONDS,
  ingestedDraftD,
  KIND_APP_DATA,
  KIND_DELETION,
  KIND_DRAFT_WRAP,
  KIND_GIFT_WRAP,
  type NostrEvent,
  parseDestinations,
  parseDraftWrap,
  parseSettings,
  pendingDestinationId,
  publishToAll,
  quotaPeriodStart,
  RelayConnection,
  type Settings,
  type SubmissionInput,
} from '@qusme/nostr';
import type { FakeRelayNetwork } from '@qusme/nostr/testing';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import { LOCAL_SYNC, SESSION_DRAFTS } from '../src/keyStore.ts';
import { SyncEngine, type SyncResult, syncOnce } from '../src/sync/engine.ts';
import { readDraftCache, readSyncState, writeSyncState } from '../src/sync/state.ts';
import { createdDevice, device, INBOX, network, PASSPHRASE, STORAGE } from './helpers.ts';

const DAY = 24 * 60 * 60;
const clock = () => Math.floor(Date.now() / 1000);
const dOf = (e: NostrEvent) => e.tags.find((t) => t[0] === 'd')?.[1];

type Created = Awaited<ReturnType<typeof createdDevice>>;

async function publishTo(net: FakeRelayNetwork, urls: string[], event: NostrEvent) {
  const connections = await Promise.all(
    urls.map((url) => RelayConnection.open(url, { socket: net.socket, timeoutMs: 500 }))
  );
  const report = await publishToAll(connections, event);
  for (const c of connections) c.close();
  expect(report.refused).toEqual([]);
}

/** A queue with one approved agent, "Claude Desktop", and a confirmed X destination. */
async function setup(
  options: { grant?: Partial<AgentGrantInput>; recipientDeletion?: boolean; second?: boolean } = {}
) {
  const net = network();
  if (options.recipientDeletion) net.get(INBOX[0] as string).options.recipientDeletion = true;
  const a = await createdDevice(net);
  const queue = createLocalSigner(a.secretKey);
  const inboxPubkey = getPublicKey(a.inboxKey);
  const agentKey = generateSecretKey();
  const agent = createLocalSigner(agentKey);
  const agentPubkey = getPublicKey(agentKey);
  const now = clock();
  await publishTo(
    net,
    STORAGE,
    await buildSubmittersList(queue, {
      [agentPubkey]: { label: 'Claude Desktop', authorized_at: now },
    })
  );
  await publishTo(
    net,
    STORAGE,
    await buildAgentGrant(queue, agentPubkey, {
      inbox: INBOX,
      inbox_pubkey: inboxPubkey,
      destinations: [{ site: 'x', account: 'lokkju', fields: ['text'] }],
      quota: { max_submissions: 50, period: 'day' },
      ...options.grant,
    })
  );
  await publishTo(
    net,
    STORAGE,
    await buildDestinations(queue, {
      destinations: [
        {
          id: 'dest-x',
          site: 'x',
          account: 'lokkju',
          label: 'X / lokkju',
          status: 'confirmed',
          override: null,
        },
      ],
    })
  );
  const submit = async (over: Partial<SubmissionInput> = {}, to = inboxPubkey) => {
    const wrap = await buildSubmission(agent, to, {
      site: 'x',
      account: 'lokkju',
      field: 'text',
      content: 'Shipping the sync engine today.\nSecond line.',
      ...over,
    });
    await publishTo(net, INBOX, wrap);
    return wrap;
  };
  const deps = (d: Pick<Created, 'store'>, extra: { cap?: number } = {}) => ({
    store: d.store,
    socket: net.socket,
    relayTimeoutMs: 500,
    ...extra,
  });
  let b: ReturnType<typeof device> | undefined;
  if (options.second) {
    b = device(net);
    const settings = (await a.store.record())?.settings;
    await b.store.save({
      secretKey: a.secretKey,
      passphrase: PASSPHRASE,
      storageRelays: STORAGE,
      ...(settings && { settings }),
    });
  }
  return { net, a, b, queue, inboxPubkey, agent, agentPubkey, submit, deps };
}

const storageDrafts = (net: FakeRelayNetwork) =>
  net.get(STORAGE[0] as string).events.filter((e) => e.kind === KIND_DRAFT_WRAP);

function synced(result: SyncResult) {
  if (result.state !== 'synced') throw new Error(`expected synced, got ${result.state}`);
  return result.summary;
}

async function latestSettings(net: FakeRelayNetwork, queue: ReturnType<typeof createLocalSigner>) {
  const events = net
    .get(STORAGE[0] as string)
    .events.filter((e) => e.kind === KIND_APP_DATA && dOf(e) === D_SETTINGS);
  const parsed = await parseSettings(events[0], queue);
  if (!parsed.ok) throw new Error('no settings');
  return parsed.value.content;
}

describe('sync engine (spec 11.4)', () => {
  it('does nothing while locked, and nothing without a queue', async () => {
    const { net, a, submit, deps } = await setup();
    await submit();
    await a.store.lock();
    const before = STORAGE.map((u) => net.get(u).requests.length);
    const inboxBefore = net.get(INBOX[0] as string).requests.length;
    expect(await syncOnce(deps(a))).toEqual({ state: 'locked' });
    expect(await new SyncEngine(deps(a)).sync()).toEqual({ state: 'locked' });
    expect(STORAGE.map((u) => net.get(u).requests.length)).toEqual(before);
    expect(net.get(INBOX[0] as string).requests.length).toBe(inboxBefore);
    expect(net.get(INBOX[0] as string).connectionCount).toBe(0);
    expect(a.local.data.has(LOCAL_SYNC)).toBe(false);
    expect(await syncOnce({ store: device(net).store, socket: net.socket })).toEqual({
      state: 'empty',
    });
  });

  it('ingests an agent submission into a draft wrap, updates settings and deletes the wrap', async () => {
    const { net, a, queue, inboxPubkey, agentPubkey, submit, deps } = await setup({
      recipientDeletion: true,
    });
    const wrap = await submit();
    const summary = synced(await syncOnce(deps(a)));
    expect(summary).toMatchObject({ ingested: 1, skipped: 0, deferred: 0, discarded: {} });
    expect(summary.errors).toEqual([]);

    for (const url of STORAGE) {
      const drafts = net.get(url).events.filter((e) => e.kind === KIND_DRAFT_WRAP);
      expect(drafts.map(dOf)).toEqual([ingestedDraftD(wrap.id)]);
      expect(drafts[0]?.tags.some((t) => t[0] === 'expiration')).toBe(false);
    }
    const parsed = await parseDraftWrap(storageDrafts(net)[0], queue);
    if (!parsed.ok || parsed.value.deleted || parsed.value.draft.type !== 'field_value') {
      throw new Error('bad draft');
    }
    expect(parsed.value.draft.value).toMatchObject({
      status: 'active',
      site: 'x',
      account: 'lokkju',
      field: 'text',
      destination: 'dest-x',
      source: { wrapId: wrap.id, submitter: agentPubkey },
      content: 'Shipping the sync engine today.\nSecond line.',
    });

    const settings = await latestSettings(net, queue);
    expect(settings.quota_counts[agentPubkey]?.accepted).toEqual([wrap.id]);
    expect(settings.inbox_key).toBe(bytesToHex(a.inboxKey));

    const inbox = net.get(INBOX[0] as string);
    const deletion = inbox.accepted.find((e) => e.kind === KIND_DELETION);
    expect(deletion?.pubkey).toBe(inboxPubkey);
    expect(deletion?.tags).toContainEqual(['e', wrap.id]);
    expect(deletion?.tags).toContainEqual(['k', String(KIND_GIFT_WRAP)]);
    expect(summary.deletionsRequested).toBe(1);
    expect(inbox.events.some((e) => e.id === wrap.id)).toBe(false);

    const cache = await readDraftCache(a.session);
    expect(cache?.drafts).toEqual([
      expect.objectContaining({
        d: ingestedDraftD(wrap.id),
        status: 'active',
        content: 'Shipping the sync engine today.\nSecond line.',
        source: { wrapId: wrap.id, submitter: agentPubkey, label: 'Claude Desktop' },
      }),
    ]);
    // Decrypted content lives in storage.session only.
    expect(a.local.dump()).not.toContain('Shipping the sync engine');
    expect((await readSyncState(a.local)).handled[wrap.id]).toBeTypeOf('number');

    await a.store.lock();
    expect(a.session.data.has(SESSION_DRAFTS)).toBe(false);
  });

  it('never turns a wrap from an unlisted pubkey into a draft, and keeps no trace of it', async () => {
    const { net, a, inboxPubkey, deps } = await setup();
    const stranger = createLocalSigner(generateSecretKey());
    const junk = await buildSubmission(stranger, inboxPubkey, {
      site: 'x',
      account: 'lokkju',
      field: 'text',
      content: 'BUY NOW junk text',
    });
    await publishTo(net, INBOX, junk);
    const summary = synced(await syncOnce(deps(a)));
    expect(summary.ingested).toBe(0);
    expect(summary.discarded).toEqual({ unauthorized_submitter: 1 });
    expect(storageDrafts(net)).toEqual([]);
    expect(a.local.dump()).not.toContain('BUY NOW');
    expect(a.session.dump()).not.toContain('BUY NOW');
    // Junk is not reopened while it stays in the lookback.
    const again = synced(await syncOnce(deps(a)));
    expect(again.skipped).toBe(1);
    expect(again.discarded).toEqual({});
  });

  it('produces one draft per wrap when two devices ingest the same wraps at once', async () => {
    const { net, a, b, submit, deps } = await setup({ second: true });
    const wraps = [await submit({ content: 'one' }), await submit({ content: 'two' })];
    if (b === undefined) throw new Error('no second device');
    const [ra, rb] = await Promise.all([syncOnce(deps(a)), syncOnce(deps(b))]);
    expect(synced(ra).errors).toEqual([]);
    expect(synced(rb).errors).toEqual([]);
    for (const url of STORAGE) {
      const ds = net
        .get(url)
        .events.filter((e) => e.kind === KIND_DRAFT_WRAP)
        .map(dOf)
        .sort();
      expect(ds).toEqual(wraps.map((w) => ingestedDraftD(w.id)).sort());
    }
  });

  it('lets the second device skip a wrap the first already ingested', async () => {
    const { net, a, b, submit, deps, queue, agentPubkey } = await setup({ second: true });
    const wrap = await submit();
    if (b === undefined) throw new Error('no second device');
    expect(synced(await syncOnce(deps(a))).ingested).toBe(1);
    // The inbox relay ignored the deletion request, as three of five probed relays did.
    expect(net.get(INBOX[0] as string).events.some((e) => e.id === wrap.id)).toBe(true);
    const second = synced(await syncOnce(deps(b)));
    expect(second).toMatchObject({ ingested: 0, skipped: 1 });
    expect(storageDrafts(net)).toHaveLength(1);
    expect((await latestSettings(net, queue)).quota_counts[agentPubkey]?.accepted).toEqual([
      wrap.id,
    ]);
    expect((await readDraftCache(b.session))?.drafts).toHaveLength(1);
  });

  it('finds a wrap whose created_at NIP-59 randomized two days back', async () => {
    const { net, a, agent, inboxPubkey, deps } = await setup();
    const lastSync = clock() - 60;
    let wrap: NostrEvent | undefined;
    for (let i = 0; i < 500 && wrap === undefined; i++) {
      const candidate = await buildSubmission(agent, inboxPubkey, {
        site: 'x',
        account: 'lokkju',
        field: 'text',
        content: 'late',
      });
      if (candidate.created_at < clock() - 47 * 60 * 60) wrap = candidate;
    }
    if (wrap === undefined) throw new Error('no wrap randomized far enough back');
    await publishTo(net, INBOX, wrap);
    await writeSyncState(a.local, {
      version: 1,
      handled: {},
      cappedStreak: 0,
      lastInboxSync: lastSync,
    });
    // A query from the last sync alone would miss it.
    expect(wrap.created_at).toBeLessThan(lastSync);

    const summary = synced(await syncOnce(deps(a)));
    expect(summary.ingested).toBe(1);
    const req = net.get(INBOX[0] as string).requests.at(-1);
    expect(req?.filters[0]?.since).toBe(lastSync - INGEST_LOOKBACK_SECONDS);
    expect(req?.authed).toEqual([inboxPubkey]);
    expect((await readSyncState(a.local)).lastInboxSync).toBeGreaterThan(lastSync);
  });

  it('leaves wraps over the cap for later syncs without moving the window', async () => {
    const { net, a, submit, deps } = await setup();
    for (let i = 0; i < 5; i++) await submit({ content: `n${i}` });
    const first = synced(await syncOnce(deps(a, { cap: 2 })));
    expect(first).toMatchObject({ ingested: 2, deferred: 3, cappedStreak: 1 });
    expect((await readSyncState(a.local)).lastInboxSync).toBeUndefined();
    const second = synced(await syncOnce(deps(a, { cap: 2 })));
    expect(second).toMatchObject({ ingested: 2, deferred: 1, cappedStreak: 2 });
    const third = synced(await syncOnce(deps(a, { cap: 2 })));
    expect(third).toMatchObject({ ingested: 1, deferred: 0, cappedStreak: 0 });
    expect(storageDrafts(net)).toHaveLength(5);
    expect((await readSyncState(a.local)).lastInboxSync).toBeTypeOf('number');
  });

  it('enforces the quota and merges counts with what other devices saved', async () => {
    const { net, a, queue, agentPubkey, submit, deps } = await setup({
      grant: { quota: { max_submissions: 2, period: 'day' } },
    });
    const now = clock();
    const start = quotaPeriodStart('day', now);
    const foreign = 'f'.repeat(64);
    const otherAgent = 'e'.repeat(64);
    // Another device already accepted one wrap this period and counted another agent.
    const current = await latestSettings(net, queue);
    const seeded: Settings = {
      ...current,
      quota_counts: {
        [agentPubkey]: { period_start: start, accepted: [foreign], discarded: [] },
        [otherAgent]: { period_start: start, accepted: [], discarded: ['d'.repeat(64)] },
      },
    };
    await publishTo(net, STORAGE, await buildSettings(queue, seeded, { createdAt: now + 1 }));

    const wraps = [await submit({ content: 'q1' }), await submit({ content: 'q2' })];
    const summary = synced(await syncOnce(deps(a)));
    expect(summary.ingested).toBe(1);
    expect(summary.discarded).toEqual({ over_quota: 1 });
    expect(storageDrafts(net)).toHaveLength(1);

    const settings = await latestSettings(net, queue);
    const count = settings.quota_counts[agentPubkey];
    expect(count?.period_start).toBe(start);
    expect(count?.accepted).toHaveLength(2);
    expect(count?.accepted).toContain(foreign);
    expect(count?.discarded).toHaveLength(1);
    expect([...(count?.accepted ?? []), ...(count?.discarded ?? [])].sort()).toEqual(
      [foreign, ...wraps.map((w) => w.id)].sort()
    );
    expect(settings.quota_counts[otherAgent]).toEqual(seeded.quota_counts[otherAgent]);
    expect(settings.inbox_key).toBe(current.inbox_key);
    expect(settings.inbox_relays).toEqual(current.inbox_relays);
  });

  it('creates a pending destination for an unknown one the grant allows', async () => {
    const { net, a, queue, submit, deps } = await setup({
      grant: { allow_new_destinations: true },
    });
    await submit({ site: 'mastodon', account: 'me@example.social' });
    expect(synced(await syncOnce(deps(a))).ingested).toBe(1);
    const events = net
      .get(STORAGE[1] as string)
      .events.filter((e) => e.kind === KIND_APP_DATA && dOf(e) === D_DESTINATIONS);
    const parsed = await parseDestinations(events[0], queue);
    if (!parsed.ok) throw new Error('no destinations');
    const id = pendingDestinationId('mastodon', 'me@example.social');
    expect(parsed.value.content.destinations.map((d) => [d.id, d.status])).toEqual([
      ['dest-x', 'confirmed'],
      [id, 'pending'],
    ]);
    const draft = await parseDraftWrap(storageDrafts(net)[0], queue);
    expect(draft.ok && !draft.value.deleted && draft.value.draft).toMatchObject({
      type: 'field_value',
      value: { destination: id },
    });
  });

  it('drains a retired inbox key until its grants’ wraps expire, then drops it', async () => {
    const { net, a, queue, submit, deps } = await setup();
    const current = await latestSettings(net, queue);
    const now = clock();
    const fresh = generateSecretKey();
    const stale = generateSecretKey();
    await publishTo(
      net,
      STORAGE,
      await buildSettings(
        queue,
        {
          ...current,
          inbox_key: bytesToHex(fresh),
          retired_inbox_keys: [
            { key: bytesToHex(a.inboxKey), retired_at: now - DAY },
            { key: bytesToHex(stale), retired_at: now - 100 * DAY },
          ],
        },
        { createdAt: now + 1 }
      )
    );
    const toRetired = await submit({ content: 'to the retired key' });
    const toCurrent = await submit({ content: 'to the new key' }, getPublicKey(fresh));
    const toStale = await submit({ content: 'too late' }, getPublicKey(stale));

    const summary = synced(await syncOnce(deps(a)));
    expect(summary.ingested).toBe(2);
    expect(storageDrafts(net).map(dOf).sort()).toEqual(
      [toRetired, toCurrent].map((w) => ingestedDraftD(w.id)).sort()
    );
    const req = net.get(INBOX[0] as string).requests.at(-1);
    expect(req?.authed.sort()).toEqual([getPublicKey(fresh), getPublicKey(a.inboxKey)].sort());
    expect(req?.filters[0]?.['#p']).not.toContain(getPublicKey(stale));
    const deletions = net.get(INBOX[0] as string).accepted.filter((e) => e.kind === KIND_DELETION);
    expect(deletions.map((e) => e.pubkey).sort()).toEqual(
      [getPublicKey(fresh), getPublicKey(a.inboxKey)].sort()
    );
    expect(deletions.flatMap((e) => e.tags)).not.toContainEqual(['e', toStale.id]);

    const settings = await latestSettings(net, queue);
    expect(settings.retired_inbox_keys).toEqual([
      { key: bytesToHex(a.inboxKey), retired_at: now - DAY },
    ]);
    expect(settings.inbox_key).toBe(bytesToHex(fresh));
    // The kept settings copy follows the newest, so the next unlock reads the new inbox key.
    expect((await a.store.record())?.settings?.id).toBe(
      net
        .get(STORAGE[0] as string)
        .events.find((e) => e.kind === KIND_APP_DATA && dOf(e) === D_SETTINGS)?.id
    );
  });

  it('runs one sync at a time', async () => {
    const { a, submit, deps } = await setup();
    await submit();
    const engine = new SyncEngine(deps(a));
    const [x, y] = [engine.sync(), engine.sync()];
    expect(x).toBe(y);
    expect(synced(await x).ingested).toBe(1);
    expect(synced(await engine.sync()).ingested).toBe(0);
  });
});

// @vitest-environment happy-dom
/**
 * A storage relay that accepts nothing (spec 9.1; lokkju/qusme#101): sync notices a relay that
 * answers REQs but never OKs an EVENT, and not one that is merely unreachable; the swap copies
 * every queue event to the replacement and switches the relay list; a replacement that fails at
 * any step changes nothing; other devices follow the new kind 10013; a fresh recovery sheet names
 * the new relays.
 */
import { bytesToHex } from '@noble/hashes/utils.js';
import {
  buildAgentGrant,
  buildDestinations,
  buildDraftDeletion,
  buildDraftWrap,
  buildPrivateRelayList,
  buildRecoveryBackup,
  buildSettings,
  buildSubmittersList,
  createLocalSigner,
  D_DESTINATIONS,
  D_RECOVERY,
  D_SETTINGS,
  encodeNcryptsec,
  generateRecoveryCode,
  KIND_AGENT_GRANT,
  KIND_APP_DATA,
  KIND_DRAFT_WRAP,
  KIND_PRIVATE_RELAYS,
  KIND_SUBMITTERS,
  type NostrEvent,
  newestFirst,
  parsePrivateRelayList,
  publishToAll,
  RelayConnection,
  recoveryCodeToWords,
  recoveryPassword,
} from '@qusme/nostr';
import { FakeRelayNetwork } from '@qusme/nostr/testing';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { render } from 'preact';
import { afterEach, describe, expect, it } from 'vitest';
import { KeyStore, LOCAL_QUEUE, type QueueRecord, SESSION_UNLOCKED } from '../src/keyStore.ts';
import {
  DEAD_RELAY_FAILURES,
  DEAD_RELAY_MIN_SPAN_SECONDS,
  deadRelays,
  type RelayHealthMap,
  WriteLog,
} from '../src/relays/health.ts';
import {
  recoverySheetFor,
  type SwapDeps,
  SwapProbeError,
  suggestReplacements,
  swapStorageRelay,
} from '../src/relays/swap.ts';
import { SetupError } from '../src/setup/deps.ts';
import { MemoryStorageArea } from '../src/storage.ts';
import { syncOnce } from '../src/sync/engine.ts';
import { readSyncState } from '../src/sync/state.ts';
import { App } from '../src/ui/app.tsx';
import { INBOX, ORIGIN, TEST_LOG_N, until } from './helpers.ts';

const GOOD = 'wss://good.example';
const DEAD = 'wss://dead.example';
const NEW = 'wss://relay.primal.net';
const HOUR = 60 * 60;
const dOf = (e: NostrEvent) => e.tags.find((t) => t[0] === 'd')?.[1];

/** A clock the tests move by hand, in unix seconds. */
function clock(start = Math.floor(Date.now() / 1000)) {
  let now = start;
  return { now: () => now, advance: (s: number) => (now += s) };
}

async function publishTo(net: FakeRelayNetwork, url: string, events: NostrEvent[]) {
  const c = await RelayConnection.open(url, { socket: net.socket, timeoutMs: 500 });
  for (const event of events) expect((await publishToAll([c], event)).refused).toEqual([]);
  c.close();
}

/** An unlocked device whose record lists `relays`, written straight into its storage areas. */
async function deviceFor(
  net: FakeRelayNetwork,
  secretKey: Uint8Array,
  inboxKey: Uint8Array,
  extra: Pick<QueueRecord, 'storageRelays' | 'settings' | 'recoveryBackup'>,
  time: ReturnType<typeof clock>
) {
  const local = new MemoryStorageArea();
  const session = new MemoryStorageArea();
  const record: QueueRecord = {
    version: 1,
    pubkey: getPublicKey(secretKey),
    ncryptsec: 'ncryptsec1unused',
    ...extra,
  };
  await local.set({ [LOCAL_QUEUE]: record });
  await session.set({
    [SESSION_UNLOCKED]: { queue: bytesToHex(secretKey), inbox: bytesToHex(inboxKey) },
  });
  const store = new KeyStore({ local, session }, { logN: TEST_LOG_N });
  const deps: SwapDeps = {
    store,
    socket: net.socket,
    relayTimeoutMs: 150,
    probe: { settleMs: 0 },
    logN: TEST_LOG_N,
    serviceOrigin: ORIGIN,
    fetch: (async () => new Response('not found', { status: 404 })) as typeof fetch,
    requestServicePermission: async () => true,
    now: time.now,
  };
  return { store, local, session, deps };
}

/**
 * A queue created when its storage relays were GOOD and DEAD, where DEAD (like nos.lol) answers
 * REQs and never an EVENT, so every event lives on GOOD alone: settings, recovery backup,
 * destinations, submitters list, an agent grant, a live draft, a deleted draft and the 10013.
 */
async function deadRelayQueue(options: { deadUrl?: string; deadOptions?: object } = {}) {
  const deadUrl = options.deadUrl ?? DEAD;
  const net = new FakeRelayNetwork();
  net.add(GOOD);
  if (deadUrl === DEAD) net.add(DEAD, { silentWrites: true, ...options.deadOptions });
  net.add(NEW);
  for (const url of INBOX) net.add(url, { restrictGiftWraps: true });
  const time = clock();
  const secretKey = generateSecretKey();
  const inboxKey = generateSecretKey();
  const queue = createLocalSigner(secretKey);
  const pubkey = getPublicKey(secretKey);
  const code = generateRecoveryCode();
  const words = recoveryCodeToWords(code).join(' ');
  const relays = [GOOD, deadUrl];
  const settings = await buildSettings(queue, {
    inbox_key: bytesToHex(inboxKey),
    inbox_relays: INBOX,
    quota_counts: {},
  });
  const backup = await buildRecoveryBackup(
    queue,
    encodeNcryptsec(secretKey, recoveryPassword(code), { logN: TEST_LOG_N })
  );
  const agentPubkey = getPublicKey(generateSecretKey());
  const events = {
    relayList: await buildPrivateRelayList(queue, relays, { createdAt: time.now() - 100 }),
    settings,
    backup,
    destinations: await buildDestinations(queue, {
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
    }),
    submitters: await buildSubmittersList(queue, {
      [agentPubkey]: { label: 'Claude Desktop', authorized_at: time.now() },
    }),
    grant: await buildAgentGrant(queue, agentPubkey, {
      inbox: INBOX,
      inbox_pubkey: getPublicKey(inboxKey),
      destinations: [{ site: 'x', account: 'lokkju', fields: ['text'] }],
      quota: { max_submissions: 50, period: 'day' },
    }),
    draft: await buildDraftWrap(queue, {
      d: 'draft-live',
      draft: {
        type: 'field_value',
        value: {
          site: 'x',
          account: 'lokkju',
          field: 'text',
          status: 'active',
          createdAt: time.now(),
          inserted: [],
          reserved: [],
          content: 'hello from the queue',
        },
      },
    }),
    deleted: (await buildDraftDeletion(queue, { d: 'draft-gone' })).blanked,
  };
  await publishTo(net, GOOD, Object.values(events));
  const a = await deviceFor(
    net,
    secretKey,
    inboxKey,
    { storageRelays: relays, settings, recoveryBackup: backup },
    time
  );
  return { net, time, secretKey, inboxKey, queue, pubkey, words, events, relays, ...a };
}

/** The queue's events stored on `url`, by kind. */
function onRelay(net: FakeRelayNetwork, url: string, pubkey: string) {
  const mine = net.get(url).events.filter((e) => e.pubkey === pubkey);
  const app = (d: string) => mine.filter((e) => e.kind === KIND_APP_DATA && dOf(e) === d);
  return {
    all: mine,
    drafts: mine.filter((e) => e.kind === KIND_DRAFT_WRAP),
    settings: app(D_SETTINGS),
    destinations: app(D_DESTINATIONS),
    recovery: app(D_RECOVERY),
    submitters: mine.filter((e) => e.kind === KIND_SUBMITTERS),
    grants: mine.filter((e) => e.kind === KIND_AGENT_GRANT),
    relayLists: mine.filter((e) => e.kind === KIND_PRIVATE_RELAYS).sort(newestFirst),
  };
}

async function relaysIn(
  event: NostrEvent | undefined,
  queue: ReturnType<typeof createLocalSigner>
) {
  const parsed = await parsePrivateRelayList(event, queue);
  if (!parsed.ok) throw new Error('no relay list');
  return parsed.value.relays;
}

async function syncHourly(deps: SwapDeps, time: ReturnType<typeof clock>, times: number) {
  let result = await syncOnce(deps);
  for (let i = 1; i < times; i += 1) {
    time.advance(HOUR);
    result = await syncOnce(deps);
  }
  if (result.state !== 'synced') throw new Error(`sync ${result.state}`);
  return result.summary;
}

describe('noticing a storage relay that accepts nothing', () => {
  it('flags a relay that answers REQs but never OKs an EVENT, after repeated failures', async () => {
    const q = await deadRelayQueue();
    const early = await syncHourly(q.deps, q.time, DEAD_RELAY_FAILURES - 1);
    expect(early.deadRelays).toBeUndefined();
    q.time.advance(HOUR);
    const result = await syncOnce(q.deps);
    if (result.state !== 'synced') throw new Error('not synced');
    expect(result.summary.deadRelays).toEqual([
      expect.objectContaining({ url: DEAD, failures: DEAD_RELAY_FAILURES }),
    ]);
    // The write check was the queue's own 10013, re-sent: the dead relay answered REQs every time.
    expect(q.net.get(DEAD).requests.length).toBeGreaterThanOrEqual(DEAD_RELAY_FAILURES);
    const health = (await readSyncState(q.local)).relayHealth ?? {};
    expect(health[GOOD]?.failures).toBe(0);
    expect(health[DEAD]?.lastReason).toMatch(/no OK/);
  });

  it('does not flag a relay that is only unreachable', async () => {
    const q = await deadRelayQueue({ deadUrl: 'wss://offline.example' });
    const summary = await syncHourly(q.deps, q.time, DEAD_RELAY_FAILURES + 2);
    expect(summary.deadRelays).toBeUndefined();
    const health = (await readSyncState(q.local)).relayHealth ?? {};
    expect(health['wss://offline.example']?.failures ?? 0).toBe(0);
  });

  it('needs the failures spread out, another relay working, and resets on one OK', () => {
    const relays = [GOOD, DEAD];
    const answered = new Set(relays);
    const step = (health: RelayHealthMap, now: number, deadAnswer: 'silent' | 'ok' | 'gone') => {
      const log = new WriteLog();
      if (deadAnswer === 'gone') {
        log.add({ accepted: [GOOD], refused: [{ url: DEAD, reason: 'connection closed' }] });
      } else if (deadAnswer === 'ok') {
        log.add({ accepted: [GOOD, DEAD], refused: [] });
      } else {
        log.add({ accepted: [GOOD], refused: [{ url: DEAD, reason: 'no OK (timed out)' }] });
      }
      return log.apply(health, relays, answered, now);
    };
    // Five failures five minutes apart: a short outage, not a dead relay.
    let health: RelayHealthMap = {};
    for (let i = 0; i < 5; i += 1) health = step(health, 1000 + i * 300, 'silent');
    expect(health[DEAD]?.failures).toBe(5);
    expect(deadRelays(health, relays)).toEqual([]);
    // Spread over the minimum span, it is.
    health = step(health, 1000 + DEAD_RELAY_MIN_SPAN_SECONDS, 'silent');
    expect(deadRelays(health, relays).map((r) => r.url)).toEqual([DEAD]);
    // A dropped connection is being offline: it neither counts nor clears.
    health = step(health, 1000 + DEAD_RELAY_MIN_SPAN_SECONDS + 300, 'gone');
    expect(health[DEAD]?.failures).toBe(6);
    // One OK clears it.
    health = step(health, 1000 + DEAD_RELAY_MIN_SPAN_SECONDS + 600, 'ok');
    expect(health[DEAD]).toEqual({
      lastOkAt: 1000 + DEAD_RELAY_MIN_SPAN_SECONDS + 600,
      failures: 0,
    });
    // With no other relay accepting writes, nothing is flagged.
    const alone: RelayHealthMap = {
      [DEAD]: { failures: 9, firstFailureAt: 0, lastFailureAt: 2 * DEAD_RELAY_MIN_SPAN_SECONDS },
    };
    expect(deadRelays(alone, relays)).toEqual([]);
  });
});

describe('replacing it', () => {
  it('suggests the default relays the queue does not already use', () => {
    expect(suggestReplacements(['wss://nos.lol', 'wss://relay.ditto.pub'])).toEqual([
      'wss://relay.primal.net',
    ]);
  });

  it('copies every queue event to the replacement and switches the relay list', async () => {
    const q = await deadRelayQueue();
    const result = await swapStorageRelay(q.deps, { dead: DEAD, replacement: NEW });
    expect(result.relays).toEqual([GOOD, NEW]);
    expect(result.copied).toEqual({
      drafts: 1,
      destinations: 1,
      settings: 1,
      recoveryBackup: 1,
      submitters: 1,
      grants: 1,
    });

    const copied = onRelay(q.net, NEW, q.pubkey);
    expect(copied.drafts.map((e) => e.id)).toEqual([q.events.draft.id]);
    expect(copied.settings.map((e) => e.id)).toEqual([q.events.settings.id]);
    expect(copied.destinations.map((e) => e.id)).toEqual([q.events.destinations.id]);
    expect(copied.recovery.map((e) => e.id)).toEqual([q.events.backup.id]);
    expect(copied.submitters.map((e) => e.id)).toEqual([q.events.submitters.id]);
    expect(copied.grants.map((e) => e.id)).toEqual([q.events.grant.id]);
    expect(await relaysIn(copied.relayLists[0], q.queue)).toEqual([GOOD, NEW]);
    expect(await relaysIn(onRelay(q.net, GOOD, q.pubkey).relayLists[0], q.queue)).toEqual([
      GOOD,
      NEW,
    ]);
    expect((await q.store.record())?.storageRelays).toEqual([GOOD, NEW]);
    // The dead relay said nothing to the new list either.
    expect(result.deadRefused).toMatch(/no OK/);

    // The next sync writes to the new list and has nothing to flag.
    const after = await syncHourly(q.deps, q.time, 1);
    expect(after.deadRelays).toBeUndefined();
    expect(Object.keys((await readSyncState(q.local)).relayHealth ?? {})).toEqual([GOOD, NEW]);
  });

  it('changes nothing when the replacement fails the storage probe', async () => {
    const q = await deadRelayQueue();
    q.net.add('wss://also-dead.example', { silentWrites: true });
    const before = onRelay(q.net, GOOD, q.pubkey)
      .all.map((e) => e.id)
      .sort();
    const error = await swapStorageRelay(q.deps, {
      dead: DEAD,
      replacement: 'wss://also-dead.example',
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SwapProbeError);
    expect((error as SwapProbeError).probe.failed?.name).toMatch(/accepts kind/);
    expect((await q.store.record())?.storageRelays).toEqual(q.relays);
    expect(
      onRelay(q.net, GOOD, q.pubkey)
        .all.map((e) => e.id)
        .sort()
    ).toEqual(before);
  });

  it('loses nothing when the replacement passes the probe and then stops keeping writes', async () => {
    const q = await deadRelayQueue();
    const flaky = q.net.add('wss://flaky.example');
    let connects = 0;
    q.deps.socket = (url) => {
      // The probe is the first connection; the copy opens the second.
      if (url === 'wss://flaky.example' && ++connects === 2) flaky.options.silentWrites = true;
      return q.net.socket(url);
    };
    const before = onRelay(q.net, GOOD, q.pubkey)
      .all.map((e) => e.id)
      .sort();
    const error = await swapStorageRelay(q.deps, {
      dead: DEAD,
      replacement: 'wss://flaky.example',
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SetupError);
    expect((error as Error).message).toMatch(/Nothing was changed/);
    expect((await q.store.record())?.storageRelays).toEqual(q.relays);
    const good = onRelay(q.net, GOOD, q.pubkey);
    expect(good.all.map((e) => e.id).sort()).toEqual(before);
    expect(await relaysIn(good.relayLists[0], q.queue)).toEqual(q.relays);

    // A second try with a working relay still has everything to copy.
    q.deps.socket = q.net.socket;
    const result = await swapStorageRelay(q.deps, { dead: DEAD, replacement: NEW });
    expect(result.copied.drafts).toBe(1);
    expect(result.copied.grants).toBe(1);
  });

  it('refuses while a remaining relay cannot be read', async () => {
    const q = await deadRelayQueue();
    q.net.relays.delete(GOOD);
    await expect(swapStorageRelay(q.deps, { dead: DEAD, replacement: NEW })).rejects.toThrow(
      /Could not reach wss:\/\/good\.example/
    );
    expect((await q.store.record())?.storageRelays).toEqual(q.relays);
  });

  it('moves other devices to the new list on their next sync', async () => {
    const q = await deadRelayQueue();
    const b = await deviceFor(
      q.net,
      q.secretKey,
      q.inboxKey,
      { storageRelays: q.relays, settings: q.events.settings },
      q.time
    );
    await swapStorageRelay(q.deps, { dead: DEAD, replacement: NEW });
    await syncOnce(b.deps);
    expect((await b.store.record())?.storageRelays).toEqual([GOOD, NEW]);
  });

  it('makes a recovery sheet naming the new relays from the typed code', async () => {
    const q = await deadRelayQueue();
    await swapStorageRelay(q.deps, { dead: DEAD, replacement: NEW });
    const sheet = await recoverySheetFor(q.deps, q.words);
    expect(sheet.storageRelays).toEqual([GOOD, NEW]);
    expect(sheet.inboxRelays).toEqual(INBOX);
    expect(sheet.words.join(' ')).toBe(q.words);
    const other = recoveryCodeToWords(generateRecoveryCode()).join(' ');
    await expect(recoverySheetFor(q.deps, other)).rejects.toThrow(/does not open/);
  });
});

describe('the popup', () => {
  let root: HTMLElement;
  afterEach(() => {
    render(null, root);
    document.body.innerHTML = '';
  });

  const button = (text: string): HTMLButtonElement => {
    const found = [...root.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
    if (found === undefined) throw new Error(`no button ${text}`);
    return found;
  };

  it('shows the dead relay, swaps it and offers a new recovery sheet', async () => {
    const q = await deadRelayQueue();
    await syncHourly(q.deps, q.time, DEAD_RELAY_FAILURES);
    root = document.createElement('div');
    document.body.append(root);
    render(<App deps={q.deps} />, root);

    await until(() => root.textContent?.includes('is keeping nothing') ?? false);
    expect(root.textContent).toContain(DEAD);
    expect(root.textContent).toContain(`none of the last ${DEAD_RELAY_FAILURES} saves`);
    button('Replace this server').click();

    await until(() => root.textContent?.includes('Replace a storage server') ?? false);
    const radio = root.querySelector<HTMLInputElement>(`input[value="${NEW}"]`);
    expect(radio?.checked).toBe(true);
    button('Check and replace').click();

    await until(() => root.textContent?.includes('Storage server replaced') ?? false, 10_000);
    expect(root.textContent).toContain(`${GOOD} and ${NEW}`);
    const input = root.querySelector<HTMLInputElement>('#sheet-code') as HTMLInputElement;
    input.value = q.words;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await until(() => !button('Make a new recovery sheet').disabled);
    button('Make a new recovery sheet').click();
    await until(() => root.textContent?.includes('The same code, for printing') ?? false, 10_000);
    expect(root.textContent).toContain(NEW);
    expect(root.textContent).not.toContain(DEAD);
  });
});

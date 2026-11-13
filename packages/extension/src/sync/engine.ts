/**
 * Sync and ingestion in the background (spec 11.4). One run: read the queue's drafts,
 * destinations, settings, rotation marker, submitters list and grants from every storage relay
 * (as the queue key where a relay asks for AUTH); read kind 1059 from the inbox relays,
 * authenticated as the inbox key and every retired inbox key still draining (6.4), since the last
 * sync minus the lookback; ingest (`ingestSubmissions` in `@qusme/nostr`); publish the new
 * pending destinations, the draft wraps and the merged settings to every storage relay; blank and
 * request deletion of archived drafts past the settings' retention (7.2, 9.2); then ask the inbox
 * relays to delete the handled gift wraps, best effort.
 *
 * Nothing runs while the queue is locked: {@link syncOnce} reads the unlocked keys first and
 * returns without opening a connection when there are none.
 */
import { hexToBytes } from '@noble/hashes/utils.js';
import {
  type AgentGrant,
  type AppData,
  buildDestinations,
  buildDraftDeletion,
  buildDraftWrap,
  buildGiftWrapDeletion,
  buildSettings,
  createLocalSigner,
  D_DESTINATIONS,
  D_ROTATED,
  D_SETTINGS,
  type Destinations,
  type DiscardReason,
  type DraftWrap,
  type IngestOutcome,
  inboxSince,
  ingestSubmissions,
  type JsonObject,
  KIND_AGENT_GRANT,
  KIND_APP_DATA,
  KIND_DRAFT_WRAP,
  KIND_GIFT_WRAP,
  KIND_PRIVATE_RELAYS,
  KIND_SUBMITTERS,
  mergeDestinations,
  mergeQuotaCounts,
  type NostrEvent,
  newestFirst,
  type PublishReport,
  parseAgentGrant,
  parseDestinations,
  parseDraftWrap,
  parsePrivateRelayList,
  parseRotationMarker,
  parseSettings,
  parseSubmittersList,
  publishToAll,
  RelayConnection,
  RelayError,
  retiredInboxDrainEnd,
  type Settings,
  type Signer,
  type SocketFactory,
  type SubmittersList,
  type WrapRef,
} from '@qusme/nostr';
import type { Filter } from 'nostr-tools/filter';
import { finishPendingRevocations } from '../agents/pendingRevocations.ts';
import { graceUntil, pastRetention, retentionChosen, retentionDays } from '../drafts/retention.ts';
import { effectiveDefinition, type SiteDefinitionSource } from '../insertion/definitions.ts';
import type { KeyStore } from '../keyStore.ts';
import { SERVICE_ORIGIN } from '../permissions.ts';
import { deadRelays, needsWriteCheck, WriteLog } from '../relays/health.ts';
import { sameRelays } from '../setup/deps.ts';
import {
  type CachedDraft,
  type DraftCache,
  EXPIRED_MAX_TRIES,
  type ExpiredDraft,
  pruneHandled,
  readSyncState,
  type SyncSummary,
  writeDraftCache,
  writeSyncState,
} from './state.ts';

export interface SyncDeps {
  store: KeyStore;
  /** The relay client's socket; defaults to the platform `WebSocket`. */
  socket?: SocketFactory;
  /** Milliseconds the relay client waits for an answer. */
  relayTimeoutMs?: number;
  /** Unix seconds; defaults to the clock. */
  now?: () => number;
  /** Gift wraps opened per sync; defaults to 100 (11.4). */
  cap?: number;
  /** Site definitions, for whether a site's accounts are case-sensitive (10.1) at ingestion. */
  definitions?: SiteDefinitionSource;
  /** The qus.me service, for finishing pending revocations (11.8); app.qus.me by default. */
  serviceOrigin?: string;
  /** The platform `fetch` by default. */
  fetch?: typeof fetch;
}

export type SyncResult =
  | { state: 'empty' }
  | { state: 'locked' }
  | { state: 'synced'; summary: SyncSummary };

/** Deletion requests name at most this many gift wraps each. */
const DELETION_BATCH = 200;

const dOf = (event: NostrEvent): string | undefined => event.tags.find((t) => t[0] === 'd')?.[1];

async function open(
  urls: readonly string[],
  deps: SyncDeps,
  autoAuth?: Signer
): Promise<{ connections: RelayConnection[]; errors: string[] }> {
  const results = await Promise.allSettled(
    urls.map((url) =>
      RelayConnection.open(url, {
        ...(deps.socket && { socket: deps.socket }),
        ...(deps.relayTimeoutMs !== undefined && { timeoutMs: deps.relayTimeoutMs }),
        ...(autoAuth && { autoAuth: (t) => autoAuth.signEvent(t) }),
      })
    )
  );
  const connections: RelayConnection[] = [];
  const errors: string[] = [];
  results.forEach((result, i) => {
    if (result.status === 'fulfilled') connections.push(result.value);
    else errors.push(`Could not reach ${urls[i]}.`);
  });
  return { connections, errors };
}

const reasonOf = (error: unknown): string =>
  error instanceof RelayError ? error.reason : (error as Error).message;

/**
 * Queries every connection; reports which failed instead of skipping them silently, and which
 * answered.
 */
async function queryEach(
  connections: readonly RelayConnection[],
  filters: Filter[]
): Promise<{ events: NostrEvent[]; errors: string[]; answered: Set<string> }> {
  const results = await Promise.allSettled(connections.map((c) => c.query(filters)));
  const byId = new Map<string, NostrEvent>();
  const errors: string[] = [];
  const answered = new Set<string>();
  results.forEach((result, i) => {
    if (result.status === 'fulfilled') {
      answered.add(connections[i]?.url as string);
      for (const event of result.value) byId.set(event.id, event);
    } else errors.push(`${connections[i]?.url} did not answer: ${reasonOf(result.reason)}`);
  });
  return { events: [...byId.values()].sort(newestFirst), errors, answered };
}

/** The newest event that parses, from events already sorted newest first. */
async function newestValid<T>(
  events: readonly NostrEvent[],
  parse: (event: NostrEvent) => Promise<{ ok: true; value: T } | { ok: false }>
): Promise<{ event: NostrEvent; value: T } | undefined> {
  for (const event of events) {
    const parsed = await parse(event);
    if (parsed.ok) return { event, value: parsed.value };
  }
  return undefined;
}

interface QueueView {
  /** Every `d` among the draft wraps, blanked ones included. */
  draftDs: Set<string>;
  drafts: DraftWrap[];
  settings?: { event: NostrEvent; value: AppData<Settings> };
  destinations?: { event: NostrEvent; value: AppData<Destinations> };
  submitters?: SubmittersList;
  grants: Map<string, AgentGrant>;
  rotatedTo?: string;
  /** The newest kind 10013, the authority on the storage relays (spec 7). */
  relayList?: { event: NostrEvent; relays: string[] };
}

async function readQueue(events: NostrEvent[], queue: Signer, pubkey: string): Promise<QueueView> {
  const view: QueueView = { draftDs: new Set(), drafts: [], grants: new Map() };
  const draftsByD = new Map<string, NostrEvent[]>();
  const appData = new Map<string, NostrEvent[]>();
  const submitters: NostrEvent[] = [];
  const relayLists: NostrEvent[] = [];
  const grantsByAgent = new Map<string, NostrEvent[]>();
  for (const event of events) {
    if (event.pubkey !== pubkey) continue;
    const d = dOf(event);
    if (event.kind === KIND_DRAFT_WRAP && d !== undefined) {
      view.draftDs.add(d);
      draftsByD.set(d, [...(draftsByD.get(d) ?? []), event]);
    } else if (event.kind === KIND_APP_DATA && d !== undefined) {
      appData.set(d, [...(appData.get(d) ?? []), event]);
    } else if (event.kind === KIND_SUBMITTERS) {
      submitters.push(event);
    } else if (event.kind === KIND_PRIVATE_RELAYS) {
      relayLists.push(event);
    } else if (event.kind === KIND_AGENT_GRANT && d !== undefined) {
      grantsByAgent.set(d, [...(grantsByAgent.get(d) ?? []), event]);
    }
  }
  for (const versions of draftsByD.values()) {
    const found = await newestValid(versions, (e) => parseDraftWrap(e, queue));
    if (found !== undefined && !found.value.deleted) view.drafts.push(found.value);
  }
  const settings = await newestValid(appData.get(D_SETTINGS) ?? [], (e) => parseSettings(e, queue));
  if (settings !== undefined) view.settings = settings;
  const destinations = await newestValid(appData.get(D_DESTINATIONS) ?? [], (e) =>
    parseDestinations(e, queue)
  );
  if (destinations !== undefined) view.destinations = destinations;
  const marker = await newestValid(appData.get(D_ROTATED) ?? [], (e) =>
    parseRotationMarker(e, queue)
  );
  if (marker !== undefined) view.rotatedTo = marker.value.newPubkey;
  const relayList = await newestValid(relayLists, (e) => parsePrivateRelayList(e, queue));
  if (relayList !== undefined) {
    view.relayList = { event: relayList.event, relays: relayList.value.relays };
  }
  const list = await newestValid(submitters, (e) => parseSubmittersList(e, queue));
  if (list !== undefined) view.submitters = list.value;
  for (const [agent, versions] of grantsByAgent) {
    const grant = await newestValid(versions, (e) => parseAgentGrant(e, queue));
    if (grant !== undefined) view.grants.set(agent, grant.value.grant);
  }
  return view;
}

function storageFilters(pubkey: string): Filter[] {
  return [
    { kinds: [KIND_DRAFT_WRAP], authors: [pubkey] },
    { kinds: [KIND_APP_DATA], authors: [pubkey], '#d': [D_DESTINATIONS, D_SETTINGS, D_ROTATED] },
    { kinds: [KIND_SUBMITTERS], authors: [pubkey] },
    { kinds: [KIND_AGENT_GRANT], authors: [pubkey] },
    { kinds: [KIND_PRIVATE_RELAYS], authors: [pubkey] },
  ];
}

/** Publishes on every storage connection, noting each relay's answer in `log`. */
async function publishLogged(
  connections: readonly RelayConnection[],
  event: NostrEvent,
  log: WriteLog
): Promise<PublishReport> {
  const report = await publishToAll(connections, event);
  log.add(report);
  return report;
}

/** Publishes on every storage connection; true only when all of them accepted. */
async function publishEverywhere(
  connections: readonly RelayConnection[],
  event: NostrEvent,
  errors: string[],
  log: WriteLog
): Promise<boolean> {
  const report = await publishLogged(connections, event, log);
  for (const refusal of report.refused) errors.push(`${refusal.url} refused: ${refusal.reason}`);
  return report.accepted.length > 0 && report.refused.length === 0;
}

/** A `created_at` that replaces `previous` even when the clocks disagree. */
const after = (now: number, previous: number | undefined): number =>
  previous === undefined ? now : Math.max(now, previous + 1);

/**
 * Runs one sync, then retries any revocation the service has not confirmed (11.8), which needs
 * the unlocked queue key too. Never throws for relay or service trouble; relay problems come back
 * in the summary's `errors`, and a revocation that still fails stays pending for the next sync.
 */
export async function syncOnce(deps: SyncDeps): Promise<SyncResult> {
  const result = await syncQueue(deps);
  if (result.state === 'synced') {
    await finishPendingRevocations({
      store: deps.store,
      serviceOrigin: deps.serviceOrigin ?? SERVICE_ORIGIN,
      fetch: deps.fetch ?? ((input, init) => fetch(input, init)),
    }).catch(() => undefined);
  }
  return result;
}

async function syncQueue(deps: SyncDeps): Promise<SyncResult> {
  const { store } = deps;
  const unlocked = await store.unlocked();
  if (unlocked === undefined) {
    return (await store.record()) === undefined ? { state: 'empty' } : { state: 'locked' };
  }
  const now = deps.now?.() ?? Math.floor(Date.now() / 1000);
  const queue = createLocalSigner(unlocked.queueKey);
  const pubkey = unlocked.record.pubkey;
  const syncState = await readSyncState(store.local);
  const errors: string[] = [];
  const summary: SyncSummary = {
    at: now,
    ingested: 0,
    skipped: 0,
    deferred: 0,
    discarded: {},
    deletionsRequested: 0,
    cappedStreak: syncState.cappedStreak,
    errors,
  };

  const storage = await open(unlocked.record.storageRelays, deps, queue);
  errors.push(...storage.errors);
  const inboxConnections: RelayConnection[] = [];
  const writes = new WriteLog();
  try {
    if (storage.connections.length === 0) return { state: 'synced', summary };
    const read = await queryEach(storage.connections, storageFilters(pubkey));
    errors.push(...read.errors);
    const view = await readQueue(read.events, queue, pubkey);
    if (view.rotatedTo !== undefined) summary.rotatedTo = view.rotatedTo;

    // Another device may have changed the storage relays (a swap, spec 9.1): the newest 10013
    // wins, and this device writes to the new list from the next sync on.
    let storageRelays = unlocked.record.storageRelays;
    if (view.relayList !== undefined && !sameRelays(view.relayList.relays, storageRelays)) {
      storageRelays = view.relayList.relays;
      await store.update({ storageRelays });
    }

    // The newest settings: from the relays, or the copy kept at setup.
    let settingsEvent = view.settings?.event;
    let settings = view.settings?.value.content;
    if (settings === undefined && unlocked.record.settings !== undefined) {
      const kept = await parseSettings(unlocked.record.settings, queue);
      if (kept.ok) {
        settingsEvent = unlocked.record.settings;
        settings = kept.value.content;
      }
    }
    if (settingsEvent !== undefined && settingsEvent.id !== unlocked.record.settings?.id) {
      await store.update({ settings: settingsEvent });
    }

    // Inbox keys: the current one and every retired one still draining (6.4).
    const inboxHex = settings?.inbox_key;
    const inboxes: Signer[] = [];
    if (inboxHex !== undefined) inboxes.push(createLocalSigner(hexToBytes(inboxHex)));
    else if (unlocked.inboxKey !== undefined) inboxes.push(createLocalSigner(unlocked.inboxKey));
    const retired = settings?.retired_inbox_keys ?? [];
    const draining = retired.filter((r) => retiredInboxDrainEnd(r, view.grants.values()) > now);
    for (const r of draining) inboxes.push(createLocalSigner(hexToBytes(r.key)));
    const retiredExpired = draining.length !== retired.length;

    // Gift wraps from the inbox relays, authenticated as each inbox key.
    let wraps: NostrEvent[] = [];
    let inboxComplete = inboxes.length > 0;
    const inboxUrls = settings?.inbox_relays ?? [];
    if (inboxes.length > 0 && inboxUrls.length > 0) {
      const opened = await open(inboxUrls, deps);
      errors.push(...opened.errors);
      if (opened.errors.length > 0) inboxComplete = false;
      for (const connection of opened.connections) {
        inboxConnections.push(connection);
        try {
          for (const inbox of inboxes) await connection.authenticate((t) => inbox.signEvent(t));
        } catch (error) {
          errors.push(`${connection.url} refused AUTH as the inbox key: ${reasonOf(error)}`);
          inboxComplete = false;
          connection.close();
        }
      }
      const authed = inboxConnections.filter((c) => !c.isClosed);
      const pubkeys = await Promise.all(inboxes.map((s) => s.getPublicKey()));
      const since = inboxSince(syncState.lastInboxSync);
      const filter: Filter = { kinds: [KIND_GIFT_WRAP], '#p': pubkeys };
      if (since !== undefined) filter.since = since;
      const got = await queryEach(authed, [filter]);
      errors.push(...got.errors);
      if (got.errors.length > 0 || authed.length === 0) inboxComplete = false;
      wraps = got.events;
    } else {
      inboxComplete = false;
    }

    const handled = new Set(Object.keys(syncState.handled));
    const { definitions } = deps;
    const outcome = await ingestSubmissions({
      wraps,
      inboxes,
      existingDraftDs: view.draftDs,
      handled,
      submitters: new Set(view.submitters?.submitters ?? []),
      grants: view.grants,
      destinations: view.destinations?.value.content.destinations ?? [],
      quotaCounts: settings?.quota_counts ?? {},
      now,
      ...(deps.cap !== undefined && { cap: deps.cap }),
      ...(definitions !== undefined && {
        definitionFor: (site: string, override: JsonObject | null | undefined) =>
          effectiveDefinition(definitions, site, override),
      }),
    });

    // 1. New pending destinations, merged into the latest destinations event.
    if (outcome.newDestinations.length > 0) {
      await publishDestinations(storage.connections, queue, pubkey, outcome, now, errors, writes);
    }

    // 2. The draft wraps. A wrap counts as published once every reachable storage relay has it.
    const published: { ref: WrapRef; event: NostrEvent }[] = [];
    for (const draft of outcome.drafts) {
      const event = await buildDraftWrap(queue, {
        d: draft.d,
        draft: { type: 'field_value', value: draft.value },
        createdAt: now,
      });
      if (await publishEverywhere(storage.connections, event, errors, writes)) {
        published.push({ ref: { wrapId: draft.wrapId, inboxPubkey: draft.inboxPubkey }, event });
      }
    }
    summary.ingested = published.length;

    // 3. Settings: quota counts merged by union into the latest, retired keys past draining dropped.
    if (outcome.quotaChanged || retiredExpired) {
      const event = await publishSettings(storage.connections, queue, pubkey, {
        outcome,
        drop: retired.filter((r) => !draining.includes(r)).map((r) => r.key),
        now,
        errors,
        log: writes,
      });
      if (event !== undefined) await store.update({ settings: event });
    }

    // 3a. Archived drafts past retention (7.2, 9.2): blanked and their deletion requested, best
    // effort, and left out of the cache below whatever the relays answered. The default (90 days,
    // D30) applies only when every storage relay answered, since a relay that did not may hold the
    // settings that turned it off, and spares everything for a week from this device's first sync
    // with it, so a queue that never chose a value loses nothing the user was not told about.
    const allAnswered = storage.errors.length === 0 && read.errors.length === 0;
    const graceFrom = syncState.retentionGraceFrom ?? now;
    const days = retentionDays(settings);
    const grace = graceUntil(settings, graceFrom);
    const deleteDays = retentionChosen(settings) || allAnswered ? days : null;
    const expired = await deleteExpired(storage.connections, queue, view.drafts, {
      days: deleteDays,
      ...(grace !== undefined && { grace }),
      now,
      previous: syncState.expired ?? {},
      allAnswered,
      log: writes,
    });
    if (expired.deleted > 0) summary.archiveDeleted = expired.deleted;

    // 3b. Whether each storage relay keeps writes (spec 9.1). A relay that answered the REQ but
    // got nothing written this sync, and none for a while, gets the current 10013 again: it
    // changes nothing on a relay that has it, and a relay that answers no EVENT shows it here.
    const health = syncState.relayHealth ?? {};
    if (view.relayList !== undefined) {
      const check = storage.connections.filter(
        (c) =>
          read.answered.has(c.url) && !writes.wrote(c.url) && needsWriteCheck(health[c.url], now)
      );
      if (check.length > 0) await publishLogged(check, view.relayList.event, writes);
    }
    const relayHealth = writes.apply(health, storageRelays, read.answered, now);
    const dead = deadRelays(relayHealth, storageRelays);
    if (dead.length > 0) summary.deadRelays = dead;

    // 4. Deletion of handled wraps on the inbox relays, signed by the key each was sent to.
    // A listed submitter with no grant yet may be mid-approval: its wrap stays for the next sync.
    const final = outcome.discarded.filter(
      (w): w is typeof w & { inboxPubkey: string } =>
        w.inboxPubkey !== undefined && w.reason !== 'no_grant'
    );
    const toDelete: WrapRef[] = [...published.map((p) => p.ref), ...outcome.skipped, ...final];
    summary.deletionsRequested = await requestDeletions(
      inboxConnections.filter((c) => !c.isClosed),
      inboxes,
      toDelete
    );

    // 5. What this device remembers: ids and counts, nothing decrypted.
    const nextHandled = pruneHandled(syncState.handled, now);
    for (const ref of toDelete) nextHandled[ref.wrapId] ??= now;
    summary.skipped = outcome.skipped.length;
    summary.deferred = outcome.deferred.length;
    for (const w of outcome.discarded) {
      summary.discarded[w.reason as DiscardReason] = (summary.discarded[w.reason] ?? 0) + 1;
    }
    summary.cappedStreak = outcome.deferred.length > 0 ? syncState.cappedStreak + 1 : 0;
    const allPublished = published.length === outcome.drafts.length;
    const nextState = {
      ...syncState,
      handled: nextHandled,
      cappedStreak: summary.cappedStreak,
      relayHealth,
      expired: expired.state,
      retentionGraceFrom: graceFrom,
      last: summary,
    };
    // The window moves only when the whole inbox was read and nothing was left behind.
    if (inboxComplete && outcome.deferred.length === 0 && allPublished) {
      nextState.lastInboxSync = now;
    }
    await writeSyncState(store.local, nextState);

    // 6. The decrypted cache for the popup, in storage.session only, and only while unlocked.
    if ((await store.status()).state === 'unlocked') {
      const labels = view.submitters?.labels ?? {};
      const drafts = view.drafts
        .filter((d) => !expired.ds.has(d.d))
        .map((d) => cached(d.d, d.createdAt, d, labels));
      for (const p of published) {
        const draft = outcome.drafts.find((d) => d.wrapId === p.ref.wrapId);
        if (draft !== undefined) {
          drafts.push(
            cached(
              draft.d,
              p.event.created_at,
              { draft: { type: 'field_value', value: draft.value } },
              labels
            )
          );
        }
      }
      const cache: DraftCache = {
        queuePubkey: pubkey,
        syncedAt: now,
        drafts: drafts.filter((d): d is CachedDraft => d !== undefined),
        destinations: mergeDestinations(
          view.destinations?.value.content.destinations ?? [],
          outcome.destinations.filter((d) => outcome.newDestinations.includes(d))
        ),
        retentionDays: days,
        retentionChosen: retentionChosen(settings),
      };
      if (grace !== undefined) cache.retentionGraceUntil = grace;
      await writeDraftCache(store.session, cache);
    }
    return { state: 'synced', summary };
  } finally {
    for (const connection of [...storage.connections, ...inboxConnections]) connection.close();
  }
}

function cached(
  d: string,
  updatedAt: number,
  wrap: Pick<DraftWrap, 'draft'>,
  labels: Record<string, { label: string }>
): CachedDraft | undefined {
  if (wrap.draft.type !== 'field_value') return undefined;
  const v = wrap.draft.value;
  const entry: CachedDraft = {
    d,
    updatedAt,
    site: v.site,
    account: v.account,
    field: v.field,
    status: v.status,
    content: v.content,
  };
  if (v.destination !== undefined) entry.destination = v.destination;
  if (v.source !== undefined) {
    entry.source = { wrapId: v.source.wrapId, submitter: v.source.submitter };
    const label = labels[v.source.submitter]?.label;
    if (label !== undefined) entry.source.label = label;
  }
  return entry;
}

/** Re-reads the latest app data event with `d`, as spec 11.4 asks before republishing. */
async function latestAppData<T>(
  connections: readonly RelayConnection[],
  pubkey: string,
  d: string,
  parse: (event: NostrEvent) => Promise<{ ok: true; value: AppData<T> } | { ok: false }>,
  errors: string[]
): Promise<AppData<T> | undefined> {
  const read = await queryEach(connections, [
    { kinds: [KIND_APP_DATA], authors: [pubkey], '#d': [d] },
  ]);
  errors.push(...read.errors);
  return (await newestValid(read.events, parse))?.value;
}

async function publishDestinations(
  connections: readonly RelayConnection[],
  queue: Signer,
  pubkey: string,
  outcome: IngestOutcome,
  now: number,
  errors: string[],
  log: WriteLog
): Promise<void> {
  const latest = await latestAppData(
    connections,
    pubkey,
    D_DESTINATIONS,
    (e) => parseDestinations(e, queue),
    errors
  );
  const content: Destinations = {
    destinations: mergeDestinations(
      latest?.content.destinations ?? [],
      outcome.destinations.filter((d) => outcome.newDestinations.includes(d))
    ),
  };
  if (latest?.content.extra !== undefined) content.extra = latest.content.extra;
  const event = await buildDestinations(queue, content, {
    createdAt: after(now, latest?.createdAt),
    ...(latest?.extraTags && { extraTags: latest.extraTags }),
  });
  await publishEverywhere(connections, event, errors, log);
}

async function publishSettings(
  connections: readonly RelayConnection[],
  queue: Signer,
  pubkey: string,
  input: { outcome: IngestOutcome; drop: string[]; now: number; errors: string[]; log: WriteLog }
): Promise<NostrEvent | undefined> {
  const latest = await latestAppData(
    connections,
    pubkey,
    D_SETTINGS,
    (e) => parseSettings(e, queue),
    input.errors
  );
  if (latest === undefined) {
    input.errors.push('No storage relay returned the settings; quota counts were not saved.');
    return undefined;
  }
  const content: Settings = {
    ...latest.content,
    quota_counts: mergeQuotaCounts(latest.content.quota_counts, input.outcome.quotaCounts),
  };
  if (latest.content.retired_inbox_keys !== undefined) {
    content.retired_inbox_keys = latest.content.retired_inbox_keys.filter(
      (r) => !input.drop.includes(r.key)
    );
  }
  const event = await buildSettings(queue, content, {
    createdAt: after(input.now, latest.createdAt),
    ...(latest.extraTags && { extraTags: latest.extraTags }),
  });
  const report = await publishLogged(connections, event, input.log);
  for (const refusal of report.refused) {
    input.errors.push(`${refusal.url} refused: ${refusal.reason}`);
  }
  return report.accepted.length > 0 ? event : undefined;
}

/**
 * Blanks each archived draft past retention and requests its deletion (spec 7.1, 9.2) on the
 * storage relays that have not taken either yet, and returns the progress to keep. A relay that
 * honors NIP-09 drops every version; one that ignores it keeps the blanked wrap, which replaces
 * the archived one, so the next sync no longer sees the draft. The record matters when the two
 * disagree: a relay that missed this sync and still serves the old version is asked again, the
 * relays that already took the request are not, and one that keeps refusing is left after
 * {@link EXPIRED_MAX_TRIES} syncs. An entry is dropped once every storage relay answered the read
 * and none of them serves that draft any more.
 */
async function deleteExpired(
  connections: readonly RelayConnection[],
  queue: Signer,
  drafts: readonly DraftWrap[],
  input: {
    days: number | null;
    /** Unix seconds before which nothing is past retention (the default's grace, D30). */
    grace?: number;
    now: number;
    previous: Record<string, ExpiredDraft>;
    allAnswered: boolean;
    log: WriteLog;
  }
): Promise<{ state: Record<string, ExpiredDraft>; ds: Set<string>; deleted: number }> {
  const state: Record<string, ExpiredDraft> = input.allAnswered ? {} : { ...input.previous };
  const ds = new Set<string>();
  let deleted = 0;
  for (const wrap of drafts) {
    if (wrap.draft.type !== 'field_value') continue;
    const draft = { status: wrap.draft.value.status, updatedAt: wrap.createdAt };
    if (!pastRetention(draft, input.days, input.now, input.grace)) continue;
    ds.add(wrap.d);
    const previous = input.previous[wrap.d];
    // A version newer than the one deleted (an older build restored it, say) starts over.
    const entry: ExpiredDraft =
      previous !== undefined && wrap.createdAt < previous.deletedAt
        ? { ...previous, done: [...previous.done] }
        : { deletedAt: after(input.now, wrap.createdAt), done: [], tries: 0 };
    const targets = connections.filter((c) => !entry.done.includes(c.url));
    if (targets.length > 0 && entry.tries < EXPIRED_MAX_TRIES) {
      const { blanked, deletion } = await buildDraftDeletion(queue, {
        d: wrap.d,
        createdAt: entry.deletedAt,
      });
      const first = await publishLogged(targets, blanked, input.log);
      // Not logged: a relay refusing kind 5 says nothing about whether it keeps the queue's writes.
      const second = await publishToAll(targets, deletion);
      const accepted = new Set([...first.accepted, ...second.accepted]);
      if (accepted.size > 0) deleted += 1;
      entry.done.push(...accepted);
      entry.tries += 1;
    }
    state[wrap.d] = entry;
  }
  return { state, ds, deleted };
}

/**
 * NIP-09 requests for the handled wraps, one batch per inbox key, signed by that key, on every
 * inbox relay. Best effort: most relays ignore them (11.4) and NIP-40 expiry bounds the wraps.
 * Returns how many wrap ids were named in a request at least one relay accepted.
 */
async function requestDeletions(
  connections: readonly RelayConnection[],
  inboxes: readonly Signer[],
  refs: readonly WrapRef[]
): Promise<number> {
  if (connections.length === 0 || refs.length === 0) return 0;
  let requested = 0;
  for (const inbox of inboxes) {
    const pubkey = await inbox.getPublicKey();
    const ids = [...new Set(refs.filter((r) => r.inboxPubkey === pubkey).map((r) => r.wrapId))];
    for (let i = 0; i < ids.length; i += DELETION_BATCH) {
      const batch = ids.slice(i, i + DELETION_BATCH);
      const request = await buildGiftWrapDeletion(inbox, batch);
      const report = await publishToAll(connections, request);
      if (report.accepted.length > 0) requested += batch.length;
    }
  }
  return requested;
}

/**
 * Runs syncs one at a time: a popup open during an alarm's sync waits for that one instead of
 * starting a second.
 */
export class SyncEngine {
  readonly deps: SyncDeps;
  #running: Promise<SyncResult> | undefined;

  constructor(deps: SyncDeps) {
    this.deps = deps;
  }

  sync(): Promise<SyncResult> {
    if (this.#running === undefined) {
      this.#running = syncOnce(this.deps).finally(() => {
        this.#running = undefined;
      });
    }
    return this.#running;
  }
}

/**
 * Reading and republishing the queue events agent approval touches (spec 7.2, 7.3, 7.4): the
 * submitters list, the agent grants, the destinations and settings, and, for a rejected pending
 * destination, the draft wraps. Each change re-reads the latest version from every storage relay
 * first and refuses to go on if any relay is unreachable or does not answer, since republishing a
 * replaceable event from a partial read could drop an agent or a destination another device added.
 */

import type { RelayConnection } from '@qusme/nostr';
import {
  type AgentGrantEvent,
  type AppData,
  createLocalSigner,
  D_DESTINATIONS,
  D_SETTINGS,
  type Destinations,
  type DraftWrap,
  KIND_AGENT_GRANT,
  KIND_APP_DATA,
  KIND_DRAFT_WRAP,
  KIND_SUBMITTERS,
  type NostrEvent,
  newestFirst,
  parseAgentGrant,
  parseDestinations,
  parseDraftWrap,
  parseSettings,
  parseSubmittersList,
  publishToAll,
  RelayError,
  type Settings,
  type Signer,
  type SubmittersList,
} from '@qusme/nostr';
import type { Filter } from 'nostr-tools/filter';
import type { QueueRecord } from '../keyStore.ts';
import { closeAll, openRelays, type SetupDeps, SetupError } from '../setup/deps.ts';

/** What the agent flows need: the setup dependencies, and a clock tests can set. */
export type AgentDeps = SetupDeps & {
  /** Unix seconds; defaults to the clock. */
  now?: () => number;
  /**
   * Milliseconds to wait before each retry of an approval the service answered with 409, while
   * the new submitters list reaches the relays it reads. Defaults to {@link APPROVAL_RETRY_MS}.
   */
  approvalRetryMs?: readonly number[];
};

/** What opening the queue's storage relays needs: the store, the relay client and the clock. */
export type QueueDeps = Pick<AgentDeps, 'store' | 'socket' | 'relayTimeoutMs' | 'now'>;

export interface QueueSession {
  queue: Signer;
  pubkey: string;
  record: QueueRecord;
  connections: RelayConnection[];
  now: number;
}

export interface QueueSnapshot {
  submitters?: SubmittersList;
  destinations?: AppData<Destinations>;
  settings?: AppData<Settings>;
  /** The newest valid grant per agent pubkey. */
  grants: Map<string, AgentGrantEvent>;
  /** The newest version of each draft wrap, deleted ones left out; read only when asked. */
  drafts: DraftWrap[];
}

export const LOCKED_MESSAGE = 'Unlock the queue first.';

/**
 * Opens every storage relay as the queue key (AUTH where a relay asks, 9.2). Throws while the
 * queue is locked (spec 11.8) or when any storage relay cannot be reached.
 */
export async function openQueue(deps: QueueDeps): Promise<QueueSession> {
  const unlocked = await deps.store.unlocked();
  if (unlocked === undefined) throw new SetupError(LOCKED_MESSAGE);
  const queue = createLocalSigner(unlocked.queueKey);
  const relays = unlocked.record.storageRelays;
  const opened = await openRelays(relays, deps, (t) => queue.signEvent(t));
  if (opened.failed.length > 0) {
    closeAll(opened.connections);
    throw new SetupError(
      `Could not reach ${opened.failed.map((f) => f.url).join(', ')}. Every storage relay must be reachable.`
    );
  }
  return {
    queue,
    pubkey: unlocked.record.pubkey,
    record: unlocked.record,
    connections: opened.connections,
    now: deps.now?.() ?? Math.floor(Date.now() / 1000),
  };
}

/** Runs `fn` with an open session and closes its connections afterwards. */
export async function withQueue<T>(
  deps: QueueDeps,
  fn: (session: QueueSession) => Promise<T>
): Promise<T> {
  const session = await openQueue(deps);
  try {
    return await fn(session);
  } finally {
    closeAll(session.connections);
  }
}

const dOf = (event: NostrEvent): string | undefined => event.tags.find((t) => t[0] === 'd')?.[1];

async function newestValid<T>(
  events: readonly NostrEvent[],
  parse: (event: NostrEvent) => Promise<{ ok: true; value: T } | { ok: false }>
): Promise<T | undefined> {
  for (const event of events) {
    const parsed = await parse(event);
    if (parsed.ok) return parsed.value;
  }
  return undefined;
}

/** Reads the latest queue events from every storage relay; throws if any relay fails to answer. */
export async function readQueue(
  session: QueueSession,
  options: { drafts?: boolean } = {}
): Promise<QueueSnapshot> {
  const { queue, pubkey } = session;
  const filters: Filter[] = [
    { kinds: [KIND_SUBMITTERS], authors: [pubkey] },
    { kinds: [KIND_AGENT_GRANT], authors: [pubkey] },
    { kinds: [KIND_APP_DATA], authors: [pubkey], '#d': [D_DESTINATIONS, D_SETTINGS] },
  ];
  if (options.drafts) filters.push({ kinds: [KIND_DRAFT_WRAP], authors: [pubkey] });
  const results = await Promise.allSettled(session.connections.map((c) => c.query(filters)));
  const byId = new Map<string, NostrEvent>();
  results.forEach((result, i) => {
    if (result.status === 'rejected') {
      const reason =
        result.reason instanceof RelayError ? result.reason.reason : String(result.reason);
      throw new SetupError(`${session.connections[i]?.url} did not answer: ${reason}`);
    }
    for (const event of result.value) if (event.pubkey === pubkey) byId.set(event.id, event);
  });
  const events = [...byId.values()].sort(newestFirst);

  const snapshot: QueueSnapshot = { grants: new Map(), drafts: [] };
  const submitters = await newestValid(
    events.filter((e) => e.kind === KIND_SUBMITTERS),
    (e) => parseSubmittersList(e, queue)
  );
  if (submitters !== undefined) snapshot.submitters = submitters;
  const appData = events.filter((e) => e.kind === KIND_APP_DATA);
  const destinations = await newestValid(
    appData.filter((e) => dOf(e) === D_DESTINATIONS),
    (e) => parseDestinations(e, queue)
  );
  if (destinations !== undefined) snapshot.destinations = destinations;
  const settings = await newestValid(
    appData.filter((e) => dOf(e) === D_SETTINGS),
    (e) => parseSettings(e, queue)
  );
  if (settings !== undefined) snapshot.settings = settings;

  const grantsByAgent = new Map<string, NostrEvent[]>();
  const draftsByD = new Map<string, NostrEvent[]>();
  for (const event of events) {
    const d = dOf(event);
    if (d === undefined) continue;
    if (event.kind === KIND_AGENT_GRANT)
      grantsByAgent.set(d, [...(grantsByAgent.get(d) ?? []), event]);
    if (event.kind === KIND_DRAFT_WRAP) draftsByD.set(d, [...(draftsByD.get(d) ?? []), event]);
  }
  for (const [agent, versions] of grantsByAgent) {
    const grant = await newestValid(versions, (e) => parseAgentGrant(e, queue));
    if (grant !== undefined) snapshot.grants.set(agent, grant);
  }
  for (const versions of draftsByD.values()) {
    const wrap = await newestValid(versions, (e) => parseDraftWrap(e, queue));
    if (wrap !== undefined && !wrap.deleted) snapshot.drafts.push(wrap);
  }
  return snapshot;
}

/** Publishes to every storage relay; returns the refusals, empty when all accepted. */
export async function publishAll(session: QueueSession, event: NostrEvent): Promise<string[]> {
  const report = await publishToAll(session.connections, event);
  const refusals = report.refused.map((r) => `${r.url} refused: ${r.reason}`);
  if (report.accepted.length === 0 && refusals.length === 0) refusals.push('no relay accepted it');
  return refusals;
}

/** Publishes to every storage relay and throws unless all of them accepted. */
export async function publishOrThrow(
  session: QueueSession,
  event: NostrEvent,
  what: string
): Promise<void> {
  const refusals = await publishAll(session, event);
  if (refusals.length > 0) {
    throw new SetupError(
      `The ${what} was not saved on every storage relay: ${refusals.join('; ')}`
    );
  }
}

/** A `created_at` that replaces `previous` even when the clocks disagree. */
export const after = (now: number, previous: number | undefined): number =>
  previous === undefined ? now : Math.max(now, previous + 1);

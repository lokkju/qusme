/**
 * Replacing a storage relay that accepts nothing (spec 9.1, "A storage relay that accepts
 * nothing"; lokkju/qusme#101). With the queue unlocked, the device:
 *
 * 1. probes the replacement as setup does (9.1: each kind and a 64 KiB event, read back, deleted);
 * 2. reads the queue's current events from every remaining storage relay, which must all answer,
 *    and from the dead relay too where it answers, since it may still serve older writes: the
 *    newest valid version of each draft wrap (live ones), the recovery backup, destinations and
 *    settings (30078), the submitters list and every agent grant, plus this device's own copies
 *    of the backup and settings when no relay has them;
 * 3. publishes each of them, as signed, to the replacement, which must accept every one;
 * 4. publishes a new kind 10013, with the dead relay replaced in place, to the replacement and
 *    every remaining relay (all must accept) and to the dead relay (best effort);
 * 5. only then writes the new list to this device's record, and copies to the replacement
 *    anything another device wrote to the remaining relays meanwhile, best effort.
 *
 * Until step 5 nothing local changes and nothing is removed anywhere, so a replacement that fails
 * at any point leaves the queue as it was: the remaining relays still hold every event, and the
 * extra copies on the failed replacement are under a list no device reads. Other devices pick up
 * the new 10013 on their next sync (`src/sync/engine.ts`).
 */

import {
  buildPrivateRelayList,
  createLocalSigner,
  D_DESTINATIONS,
  D_RECOVERY,
  D_SETTINGS,
  decodeNcryptsec,
  formatRecoveryBase32,
  KIND_AGENT_GRANT,
  KIND_APP_DATA,
  KIND_DRAFT_WRAP,
  KIND_PRIVATE_RELAYS,
  KIND_SUBMITTERS,
  type NostrEvent,
  newestFirst,
  type ProbeResult,
  parseAgentGrant,
  parseDestinations,
  parseDraftWrap,
  parsePrivateRelayList,
  parseRecoveryBackup,
  parseRecoveryCode,
  parseSettings,
  parseSubmittersList,
  probeStorageRelay,
  publishToAll,
  type RelayConnection,
  RelayError,
  recoveryCodeToBase32,
  recoveryCodeToWords,
  recoveryPassword,
  type Signer,
} from '@qusme/nostr';
import type { Filter } from 'nostr-tools/filter';
import { npubEncode } from 'nostr-tools/nip19';
import { getPublicKey } from 'nostr-tools/pure';
import { DEFAULT_STORAGE_RELAYS } from '../setup/create.ts';
import {
  cleanRelayUrl,
  closeAll,
  loadQueueState,
  normalizeRelayUrl,
  openRelays,
  type SetupDeps,
  SetupError,
} from '../setup/deps.ts';
import type { RecoverySheet } from '../setup/recoverySheet.ts';
import { readSyncState, writeSyncState } from '../sync/state.ts';

export type SwapDeps = SetupDeps & {
  /** Unix seconds; defaults to the clock. */
  now?: () => number;
};

/** The replacement failed the storage probe (9.1); `probe` names the failing check. */
export class SwapProbeError extends SetupError {
  readonly probe: ProbeResult;
  constructor(probe: ProbeResult) {
    const failed = probe.failed;
    super(
      `${probe.url} failed the storage check: ${failed?.name ?? 'unknown'}${
        failed?.detail !== undefined ? ` (${failed.detail})` : ''
      }. Nothing was changed.`
    );
    this.probe = probe;
  }
}

/** How many events of each kind went to the replacement. */
export interface SwapCounts {
  drafts: number;
  destinations: number;
  settings: number;
  recoveryBackup: number;
  submitters: number;
  grants: number;
}

export interface SwapResult {
  /** The queue's storage relays now. */
  relays: string[];
  copied: SwapCounts;
  /** Events written to the remaining relays during the swap and copied afterwards. */
  caughtUp: number;
  /** The dead relay's answer to the new 10013, when it refused or said nothing. */
  deadRefused?: string;
}

const dOf = (event: NostrEvent): string | undefined => event.tags.find((t) => t[0] === 'd')?.[1];

const reasonOf = (error: unknown): string =>
  error instanceof RelayError ? error.reason : (error as Error).message;

/** A `created_at` that replaces `previous` even when the clocks disagree. */
const after = (now: number, previous: number | undefined): number =>
  previous === undefined ? now : Math.max(now, previous + 1);

/** The default storage relays (9.1) not already in the queue's list, to offer as replacements. */
export function suggestReplacements(current: readonly string[]): string[] {
  const have = new Set(current.map(normalizeRelayUrl));
  return DEFAULT_STORAGE_RELAYS.filter((url) => !have.has(normalizeRelayUrl(url)));
}

function storageFilters(pubkey: string): Filter[] {
  return [
    { kinds: [KIND_DRAFT_WRAP], authors: [pubkey] },
    {
      kinds: [KIND_APP_DATA],
      authors: [pubkey],
      '#d': [D_RECOVERY, D_DESTINATIONS, D_SETTINGS],
    },
    { kinds: [KIND_SUBMITTERS], authors: [pubkey] },
    { kinds: [KIND_AGENT_GRANT], authors: [pubkey] },
    { kinds: [KIND_PRIVATE_RELAYS], authors: [pubkey] },
  ];
}

/** The newest event in `versions` (sorted newest first) that `valid` accepts. */
async function newestValid(
  versions: readonly NostrEvent[],
  valid: (event: NostrEvent) => Promise<boolean> | boolean
): Promise<NostrEvent | undefined> {
  for (const event of versions) if (await valid(event)) return event;
  return undefined;
}

interface QueueCopy {
  /** What goes to the replacement, by kind name. */
  events: { kind: keyof SwapCounts; event: NostrEvent }[];
  /** The current 10013, for its `created_at`. */
  relayList?: NostrEvent;
}

/**
 * The events to copy: the newest valid version of each address, deleted draft wraps left out,
 * with this device's kept copies of the backup and the settings filling in for (or replacing an
 * older) relay copy.
 */
async function selectQueue(
  events: readonly NostrEvent[],
  queue: Signer,
  pubkey: string,
  kept: { recoveryBackup?: NostrEvent | undefined; settings?: NostrEvent | undefined }
): Promise<QueueCopy> {
  const groups = new Map<string, NostrEvent[]>();
  const add = (key: string, event: NostrEvent) =>
    groups.set(key, [...(groups.get(key) ?? []), event]);
  for (const event of events) {
    if (event.pubkey !== pubkey) continue;
    const d = dOf(event);
    if (event.kind === KIND_DRAFT_WRAP && d !== undefined) add(`draft:${d}`, event);
    else if (event.kind === KIND_APP_DATA && d !== undefined) add(`app:${d}`, event);
    else if (event.kind === KIND_SUBMITTERS) add('submitters', event);
    else if (event.kind === KIND_AGENT_GRANT && d !== undefined) add(`grant:${d}`, event);
    else if (event.kind === KIND_PRIVATE_RELAYS) add('relays', event);
  }
  if (kept.recoveryBackup !== undefined) add(`app:${D_RECOVERY}`, kept.recoveryBackup);
  if (kept.settings !== undefined) add(`app:${D_SETTINGS}`, kept.settings);

  const copy: QueueCopy = { events: [] };
  for (const [key, list] of groups) {
    const versions = [...new Map(list.map((e) => [e.id, e])).values()].sort(newestFirst);
    if (key.startsWith('draft:')) {
      // A blanked newest version means the draft was deleted: there is nothing to copy.
      for (const event of versions) {
        const parsed = await parseDraftWrap(event, queue);
        if (!parsed.ok) continue;
        if (!parsed.value.deleted) copy.events.push({ kind: 'drafts', event });
        break;
      }
    } else if (key === `app:${D_RECOVERY}`) {
      const event = await newestValid(
        versions,
        (e) => parseRecoveryBackup(e, { queuePubkey: pubkey }).ok
      );
      if (event !== undefined) copy.events.push({ kind: 'recoveryBackup', event });
    } else if (key === `app:${D_DESTINATIONS}`) {
      const event = await newestValid(
        versions,
        async (e) => (await parseDestinations(e, queue)).ok
      );
      if (event !== undefined) copy.events.push({ kind: 'destinations', event });
    } else if (key === `app:${D_SETTINGS}`) {
      const event = await newestValid(versions, async (e) => (await parseSettings(e, queue)).ok);
      if (event !== undefined) copy.events.push({ kind: 'settings', event });
    } else if (key === 'submitters') {
      const event = await newestValid(
        versions,
        async (e) => (await parseSubmittersList(e, queue)).ok
      );
      if (event !== undefined) copy.events.push({ kind: 'submitters', event });
    } else if (key.startsWith('grant:')) {
      const event = await newestValid(versions, async (e) => (await parseAgentGrant(e, queue)).ok);
      if (event !== undefined) copy.events.push({ kind: 'grants', event });
    } else if (key === 'relays') {
      const event = await newestValid(
        versions,
        async (e) => (await parsePrivateRelayList(e, queue)).ok
      );
      if (event !== undefined) copy.relayList = event;
    }
  }
  return copy;
}

/** Every event matching the filters on `connections`, by id; throws naming a relay that fails. */
async function readAll(
  connections: readonly RelayConnection[],
  filters: Filter[],
  strict: boolean
): Promise<NostrEvent[]> {
  const results = await Promise.allSettled(connections.map((c) => c.query(filters)));
  const byId = new Map<string, NostrEvent>();
  results.forEach((result, i) => {
    if (result.status === 'fulfilled') {
      for (const event of result.value) byId.set(event.id, event);
    } else if (strict) {
      throw new SetupError(
        `Could not read the queue from ${connections[i]?.url} (${reasonOf(result.reason)}). Nothing was changed.`
      );
    }
  });
  return [...byId.values()];
}

/** Publishes `event` on one connection; the relay's refusal or silence as a string, or undefined. */
async function publishOne(
  connection: RelayConnection,
  event: NostrEvent
): Promise<string | undefined> {
  try {
    await connection.publish(event);
    return undefined;
  } catch (error) {
    return reasonOf(error);
  }
}

/**
 * Replaces `dead` with `replacement` among the queue's storage relays, copying the queue there
 * first (see the module comment). Throws {@link SwapProbeError} when the replacement fails the
 * probe and {@link SetupError} for anything else; in every failure the queue keeps its relays.
 */
export async function swapStorageRelay(
  deps: SwapDeps,
  input: { dead: string; replacement: string }
): Promise<SwapResult> {
  const unlocked = await deps.store.unlocked();
  if (unlocked === undefined) throw new SetupError('Unlock the queue first.');
  const { record } = unlocked;
  const list = record.storageRelays;
  const dead = list.find((url) => normalizeRelayUrl(url) === normalizeRelayUrl(input.dead));
  if (dead === undefined) throw new SetupError(`${input.dead} is not one of the queue's relays.`);
  const replacement = cleanRelayUrl(input.replacement);
  if (replacement === undefined) {
    throw new SetupError(`${input.replacement.trim()} is not a wss:// relay URL.`);
  }
  if (list.some((url) => normalizeRelayUrl(url) === replacement)) {
    throw new SetupError(`${replacement} is already one of the queue's relays.`);
  }
  const remaining = list.filter((url) => url !== dead);
  if (remaining.length === 0) {
    throw new SetupError('The queue has no other storage relay to copy its events from.');
  }

  const probe = await probeStorageRelay(replacement, {
    ...deps.probe,
    ...(deps.socket && { socket: deps.socket }),
    ...(deps.relayTimeoutMs !== undefined && { timeoutMs: deps.relayTimeoutMs }),
  });
  if (!probe.ok) throw new SwapProbeError(probe);

  const now = deps.now?.() ?? Math.floor(Date.now() / 1000);
  const queue = createLocalSigner(unlocked.queueKey);
  const pubkey = record.pubkey;
  const auth = (t: Parameters<Signer['signEvent']>[0]) => queue.signEvent(t);
  const filters = storageFilters(pubkey);

  const opened = await openRelays([...remaining, dead, replacement], deps, auth);
  const byUrl = new Map(opened.connections.map((c) => [c.url, c]));
  try {
    const unreachable = opened.failed.filter((f) => f.url !== dead);
    if (unreachable.length > 0) {
      throw new SetupError(
        `Could not reach ${unreachable.map((f) => f.url).join(', ')}. Nothing was changed.`
      );
    }
    const remainingConnections = remaining.map((url) => byUrl.get(url) as RelayConnection);
    const deadConnection = byUrl.get(dead);
    const target = byUrl.get(replacement) as RelayConnection;

    // 2. Read: every remaining relay must answer; the dead one only adds what it still has.
    const events = [
      ...(await readAll(remainingConnections, filters, true)),
      ...(deadConnection === undefined ? [] : await readAll([deadConnection], filters, false)),
    ];
    const copy = await selectQueue(events, queue, pubkey, {
      recoveryBackup: record.recoveryBackup,
      settings: record.settings,
    });
    const seen = new Set(events.map((e) => e.id));

    // 3. Copy to the replacement; every event must be accepted.
    const copied: SwapCounts = {
      drafts: 0,
      destinations: 0,
      settings: 0,
      recoveryBackup: 0,
      submitters: 0,
      grants: 0,
    };
    for (const { kind, event } of copy.events) {
      const refused = await publishOne(target, event);
      if (refused !== undefined) {
        throw new SetupError(
          `${replacement} did not keep the queue's events (${refused}). Nothing was changed; the queue stays on its current relays.`
        );
      }
      copied[kind] += 1;
    }

    // 4. The new relay list, in the dead relay's place, to the replacement and every other relay.
    const relays = list.map((url) => (url === dead ? replacement : url));
    const relayList = await buildPrivateRelayList(queue, relays, {
      createdAt: after(now, copy.relayList?.created_at),
    });
    const refusedByTarget = await publishOne(target, relayList);
    if (refusedByTarget !== undefined) {
      throw new SetupError(
        `${replacement} did not keep the new relay list (${refusedByTarget}). Nothing was changed; the queue stays on its current relays.`
      );
    }
    const report = await publishToAll(remainingConnections, relayList);
    if (report.refused.length > 0) {
      const detail = report.refused.map((r) => `${r.url} (${r.reason})`).join(', ');
      throw new SetupError(
        `The new relay list was not saved on ${detail}. This device keeps the current relays; try again.`
      );
    }
    const deadRefused =
      deadConnection === undefined ? 'not reachable' : await publishOne(deadConnection, relayList);

    // 5. Commit locally, then forget the dead relay's record.
    await deps.store.update({ storageRelays: relays });
    const state = await readSyncState(deps.store.local);
    if (state.relayHealth !== undefined) {
      const { [dead]: _dropped, ...rest } = state.relayHealth;
      state.relayHealth = rest;
    }
    if (state.last?.deadRelays !== undefined) {
      const left = state.last.deadRelays.filter((r) => r.url !== dead);
      if (left.length > 0) state.last.deadRelays = left;
      else delete state.last.deadRelays;
    }
    await writeSyncState(deps.store.local, state);

    // Anything another device wrote to the remaining relays meanwhile, best effort.
    let caughtUp = 0;
    const later = await readAll(remainingConnections, filters, false).catch(() => []);
    const fresh = later.filter((e) => !seen.has(e.id) && e.kind !== KIND_PRIVATE_RELAYS);
    if (fresh.length > 0) {
      const extra = await selectQueue(fresh, queue, pubkey, {});
      for (const { event } of extra.events) {
        if ((await publishOne(target, event)) === undefined) caughtUp += 1;
      }
    }

    const result: SwapResult = { relays, copied, caughtUp };
    if (deadRefused !== undefined) result.deadRefused = deadRefused;
    return result;
  } finally {
    closeAll(opened.connections);
  }
}

/**
 * A fresh recovery sheet (6.1) with the queue's current relays. The device does not keep the
 * recovery code, so the user types it; it must open the queue's recovery backup (this device's
 * copy, or the one on the storage relays), which proves it is the code the sheet should carry.
 */
export async function recoverySheetFor(deps: SetupDeps, typed: string): Promise<RecoverySheet> {
  const unlocked = await deps.store.unlocked();
  if (unlocked === undefined) throw new SetupError('Unlock the queue first.');
  const { record } = unlocked;
  const bytes = parseRecoveryCode(typed);
  if (bytes === undefined) {
    throw new SetupError('That is not a recovery code: type the 12 words or the 26 characters.');
  }
  try {
    const queue = createLocalSigner(unlocked.queueKey);
    let backupEvent = record.recoveryBackup;
    if (backupEvent === undefined) {
      backupEvent = (await loadQueueState(queue, record.storageRelays, deps)).recoveryBackup;
    }
    const backup = backupEvent && parseRecoveryBackup(backupEvent, { queuePubkey: record.pubkey });
    if (backup === undefined || !backup.ok) {
      throw new SetupError('No recovery backup was found to check the code against.');
    }
    let opened: Uint8Array;
    try {
      opened = decodeNcryptsec(backup.value.ncryptsec, recoveryPassword(bytes));
    } catch {
      throw new SetupError("That recovery code does not open this queue's backup.");
    }
    const matches = getPublicKey(opened) === record.pubkey;
    opened.fill(0);
    if (!matches) throw new SetupError("That recovery code does not open this queue's backup.");

    let inboxRelays: string[] = [];
    if (record.settings !== undefined) {
      const settings = await parseSettings(record.settings, queue);
      if (settings.ok) inboxRelays = [...(settings.value.content.inbox_relays ?? [])];
    }
    return {
      words: recoveryCodeToWords(bytes),
      base32: formatRecoveryBase32(recoveryCodeToBase32(bytes)),
      npub: npubEncode(record.pubkey),
      storageRelays: [...record.storageRelays],
      inboxRelays,
      createdAt: new Date(),
    };
  } finally {
    bytes.fill(0);
  }
}

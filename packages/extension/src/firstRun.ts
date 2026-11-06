/**
 * The first-run checklist on the unlocked home screen: connect Claude, add a destination, pair a
 * second device. Each item ticks itself off from the queue's state: a confirmed destination
 * exists (7.2); an agent is listed in the submitters list (7.3) or bound at the service (8.2);
 * this device paired with another (8.3), or the user skipped that item. The checklist shows until
 * every item is ticked or the user dismisses it.
 *
 * `storage.local` key `qusme.firstRun`: {@link FirstRunRecord}, for the queue it names only (a
 * record for another queue reads as empty). It holds no secret and nothing the relays don't.
 */
import { createLocalSigner } from '@qusme/nostr';
import { type AgentDeps, readQueue, withQueue } from './agents/queue.ts';
import { listBindings } from './agents/service.ts';
import type { StorageArea } from './storage.ts';
import { readDraftCache } from './sync/state.ts';

export const LOCAL_FIRST_RUN = 'qusme.firstRun';

export interface FirstRunRecord {
  queuePubkey: string;
  /** The user hid the checklist. */
  dismissed?: boolean;
  /** This device paired with another (either side), or the user chose to skip pairing. */
  device?: 'paired' | 'skipped';
}

export async function readFirstRun(
  local: StorageArea,
  queuePubkey: string
): Promise<FirstRunRecord> {
  const value = (await local.get([LOCAL_FIRST_RUN]))[LOCAL_FIRST_RUN];
  if (typeof value === 'object' && value !== null) {
    const record = value as FirstRunRecord;
    if (record.queuePubkey === queuePubkey) return record;
  }
  return { queuePubkey };
}

export async function updateFirstRun(
  local: StorageArea,
  queuePubkey: string,
  patch: Partial<Omit<FirstRunRecord, 'queuePubkey'>>
): Promise<void> {
  const record = await readFirstRun(local, queuePubkey);
  await local.set({ [LOCAL_FIRST_RUN]: { ...record, ...patch, queuePubkey } });
}

/** Records that this device took part in a pairing, for the stored queue. */
export async function markPaired(deps: Pick<AgentDeps, 'store'>): Promise<void> {
  const record = await deps.store.record();
  if (record !== undefined)
    await updateFirstRun(deps.store.local, record.pubkey, { device: 'paired' });
}

export interface ChecklistState {
  /** An agent is listed or bound. */
  agent: boolean;
  /** A confirmed destination exists. */
  destination: boolean;
  /** A second device is paired, or the user skipped it. */
  device: boolean;
  dismissed: boolean;
}

/** True once the checklist has nothing left to show. */
export const checklistDone = (state: ChecklistState): boolean =>
  state.dismissed || (state.agent && state.destination && state.device);

/** How many of the three items are ticked. */
export const checklistCount = (state: ChecklistState): number =>
  [state.agent, state.destination, state.device].filter(Boolean).length;

/**
 * Reads the checklist's state: the stored record first, then the last sync's destinations, then
 * (while anything is unticked) the storage relays and the service. A relay or service that fails
 * leaves its items as the cache had them; the checklist is a hint, never a gate.
 */
export async function loadChecklist(deps: AgentDeps): Promise<ChecklistState | undefined> {
  const unlocked = await deps.store.unlocked();
  if (unlocked === undefined) return undefined;
  const pubkey = unlocked.record.pubkey;
  const stored = await readFirstRun(deps.store.local, pubkey);
  const cache = await readDraftCache(deps.store.session);
  const state: ChecklistState = {
    agent: false,
    destination:
      cache?.queuePubkey === pubkey &&
      (cache.destinations ?? []).some((d) => d.status === 'confirmed'),
    device: stored.device !== undefined,
    dismissed: stored.dismissed === true,
  };
  if (checklistDone(state)) return state;
  try {
    const snapshot = await withQueue(deps, (session) => readQueue(session));
    state.destination = (snapshot.destinations?.content.destinations ?? []).some(
      (d) => d.status === 'confirmed'
    );
    state.agent = (snapshot.submitters?.submitters ?? []).length > 0;
  } catch {
    // Unreachable relays: keep what the cache said.
  }
  if (!state.agent) {
    try {
      state.agent = (await listBindings(createLocalSigner(unlocked.queueKey), deps)).length > 0;
    } catch {
      // No host permission yet, or the service is down.
    }
  }
  return state;
}

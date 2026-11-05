/**
 * What the sync engine keeps between runs (spec 11.4).
 *
 * `storage.local` `qusme.sync` ({@link SyncState}): when the inbox was last read in full, the
 * gift wrap ids this device has handled (so junk is not reopened while it stays inside the
 * lookback), how many syncs in a row hit the cap, and the counts from the last sync. Ids and
 * counts only: nothing decrypted is written to `storage.local`.
 *
 * `storage.session` `qusme.drafts` ({@link DraftCache}): the decrypted drafts from the last sync,
 * for the popup. Lock deletes it with the keys.
 */
import type { Destination, DiscardReason, FieldValueStatus } from '@qusme/nostr';
import { LOCAL_SYNC, SESSION_DRAFTS } from '../keyStore.ts';
import type { StorageArea } from '../storage.ts';

/** How long a handled wrap id is remembered: the longest submission expiration plus the lookback. */
export const HANDLED_RETENTION_SECONDS = (90 + 3) * 24 * 60 * 60;

/** Syncs in a row at the cap before the popup suggests rotating the inbox key (11.4). */
export const CAP_STREAK_WARNING = 3;

export interface SyncSummary {
  /** Unix seconds. */
  at: number;
  /** Drafts created from submissions and published. */
  ingested: number;
  /** Wraps already ingested, by this device or another. */
  skipped: number;
  /** Wraps over the cap, left for the next sync. */
  deferred: number;
  /** Junk counted by reason; its content is never kept or shown. */
  discarded: Partial<Record<DiscardReason, number>>;
  /** Gift wrap ids named in deletion requests sent to the inbox relays. */
  deletionsRequested: number;
  /** Consecutive syncs that hit the cap, this one included. */
  cappedStreak: number;
  /** Relay problems, written for the user. */
  errors: string[];
  /** The new queue pubkey when a rotation marker was found (6.1). */
  rotatedTo?: string;
}

export interface SyncState {
  version: 1;
  /** When the inbox was last read with nothing deferred and every inbox relay answering. */
  lastInboxSync?: number;
  /** Gift wrap id to the unix time it was handled. */
  handled: Record<string, number>;
  cappedStreak: number;
  last?: SyncSummary;
}

export interface CachedDraft {
  d: string;
  /** The wrap's `created_at`: when the draft was last published. */
  updatedAt: number;
  site: string;
  account: string;
  field: string;
  status: FieldValueStatus;
  destination?: string;
  content: string;
  /** Present for agent submissions, with the submitter's label from the submitters list. */
  source?: { wrapId: string; submitter: string; label?: string };
}

export interface DraftCache {
  queuePubkey: string;
  syncedAt: number;
  drafts: CachedDraft[];
  /** The destinations (7.2), overrides included, for matching drafts to the page (11.5). */
  destinations?: Destination[];
}

const emptyState = (): SyncState => ({ version: 1, handled: {}, cappedStreak: 0 });

export async function readSyncState(local: StorageArea): Promise<SyncState> {
  const value = (await local.get([LOCAL_SYNC]))[LOCAL_SYNC];
  if (typeof value !== 'object' || value === null) return emptyState();
  const state = value as SyncState;
  if (state.version !== 1 || typeof state.handled !== 'object' || state.handled === null) {
    return emptyState();
  }
  return state;
}

export async function writeSyncState(local: StorageArea, state: SyncState): Promise<void> {
  await local.set({ [LOCAL_SYNC]: state });
}

/** Drops handled ids older than {@link HANDLED_RETENTION_SECONDS}. */
export function pruneHandled(handled: Record<string, number>, now: number): Record<string, number> {
  const kept: Record<string, number> = {};
  for (const [id, at] of Object.entries(handled)) {
    if (at > now - HANDLED_RETENTION_SECONDS) kept[id] = at;
  }
  return kept;
}

export async function readDraftCache(session: StorageArea): Promise<DraftCache | undefined> {
  const value = (await session.get([SESSION_DRAFTS]))[SESSION_DRAFTS];
  if (typeof value !== 'object' || value === null) return undefined;
  const cache = value as DraftCache;
  return Array.isArray(cache.drafts) ? cache : undefined;
}

export async function writeDraftCache(session: StorageArea, cache: DraftCache): Promise<void> {
  await session.set({ [SESSION_DRAFTS]: cache });
}

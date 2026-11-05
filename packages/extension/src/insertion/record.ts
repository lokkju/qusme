/**
 * Step 6 of spec 11.5: after a successful insertion, append an `inserted` tag, set `status` to
 * `archived:inserted` and republish the draft wrap to every storage relay. The wrap is rebuilt
 * from the newest version on the relays, not from the popup's cache, so earlier `inserted` tags,
 * the `validation` tag, reserved tags and tags a newer build wrote all survive (7, "Unknown
 * fields").
 */
import {
  buildDraftWrap,
  createLocalSigner,
  type FieldValue,
  type Insertion,
  KIND_DRAFT_WRAP,
  type NostrEvent,
  parseDraftWrap,
  publishToAll,
  queryAll,
  type SocketFactory,
} from '@qusme/nostr';
import type { KeyStore } from '../keyStore.ts';
import { closeAll, openRelays } from '../setup/deps.ts';
import { readDraftCache, writeDraftCache } from '../sync/state.ts';

export interface RecordDeps {
  store: KeyStore;
  socket?: SocketFactory;
  relayTimeoutMs?: number;
  /** Unix seconds; defaults to the clock. */
  now?: () => number;
}

export type RecordResult =
  | { state: 'recorded'; event: NostrEvent }
  /** Worth trying again later: locked, no relay answered, or a relay refused. */
  | { state: 'retry'; message: string }
  /** Not worth trying again: the draft is gone or is not a field value. */
  | { state: 'gone'; message: string };

/**
 * Records `insertion` on draft `d`. Recorded means every reachable storage relay accepted the new
 * wrap, as for ingested drafts (11.4); the cached copy is marked archived as soon as one has.
 */
export async function recordInsertion(
  deps: RecordDeps,
  d: string,
  insertion: Insertion
): Promise<RecordResult> {
  const unlocked = await deps.store.unlocked();
  if (unlocked === undefined) {
    return { state: 'retry', message: 'The queue is locked; unlock it to record the insertion.' };
  }
  const now = deps.now?.() ?? Math.floor(Date.now() / 1000);
  const queue = createLocalSigner(unlocked.queueKey);
  const pubkey = unlocked.record.pubkey;
  const opened = await openRelays(unlocked.record.storageRelays, deps, (t) => queue.signEvent(t));
  try {
    if (opened.connections.length === 0) {
      return { state: 'retry', message: 'No storage relay answered.' };
    }
    const events = await queryAll(opened.connections, [
      { kinds: [KIND_DRAFT_WRAP], authors: [pubkey], '#d': [d] },
    ]);
    let latest: { createdAt: number; value: FieldValue } | undefined;
    for (const event of events) {
      const parsed = await parseDraftWrap(event, queue);
      if (!parsed.ok) continue;
      if (parsed.value.deleted) {
        return { state: 'gone', message: 'The draft was deleted on another device.' };
      }
      if (parsed.value.draft.type !== 'field_value') {
        return { state: 'gone', message: 'The draft is not a field value.' };
      }
      latest = { createdAt: parsed.value.createdAt, value: parsed.value.draft.value };
      break;
    }
    if (latest === undefined) {
      return { state: 'retry', message: 'No storage relay returned the draft.' };
    }
    const value: FieldValue = {
      ...latest.value,
      status: 'archived:inserted',
      inserted: [...latest.value.inserted, insertion],
    };
    const event = await buildDraftWrap(queue, {
      d,
      draft: { type: 'field_value', value },
      createdAt: Math.max(now, latest.createdAt + 1),
    });
    const report = await publishToAll(opened.connections, event);
    if (report.accepted.length > 0) await markArchived(deps.store, d, event.created_at);
    if (report.accepted.length === 0 || report.refused.length > 0) {
      const refusals = report.refused.map((r) => `${r.url} refused: ${r.reason}`).join('; ');
      return { state: 'retry', message: refusals || 'No storage relay accepted the update.' };
    }
    return { state: 'recorded', event };
  } finally {
    closeAll(opened.connections);
  }
}

/** Marks the cached copy archived, so the popup stops offering it before the next sync. */
async function markArchived(store: KeyStore, d: string, updatedAt: number): Promise<void> {
  const cache = await readDraftCache(store.session);
  if (cache === undefined) return;
  const drafts = cache.drafts.map((draft) =>
    draft.d === d ? { ...draft, status: 'archived:inserted' as const, updatedAt } : draft
  );
  await writeDraftCache(store.session, { ...cache, drafts });
}

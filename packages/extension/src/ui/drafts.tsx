/**
 * The popup's list of active drafts (spec 11.4, 11.5): read from the decrypted cache in
 * `storage.session` after asking the background to sync. Draft text, sites, accounts and agent
 * labels come from agents and relays, so every one is a JSX text child, which Preact sets as text.
 */
import { useEffect, useState } from 'preact/hooks';
import type { SetupDeps } from '../setup/deps.ts';
import {
  CAP_STREAK_WARNING,
  type CachedDraft,
  type DraftCache,
  readDraftCache,
  readSyncState,
  type SyncSummary,
} from '../sync/state.ts';

const FIRST_LINE_MAX = 80;

/** The draft's first non-empty line, cut to 80 characters. */
export function firstLine(content: string): string {
  const line = content.split('\n').find((l) => l.trim() !== '') ?? '';
  return line.length > FIRST_LINE_MAX ? `${line.slice(0, FIRST_LINE_MAX - 1)}…` : line;
}

const discardedTotal = (summary: SyncSummary): number =>
  Object.values(summary.discarded).reduce((sum, n) => sum + (n ?? 0), 0);

export function DraftList(props: {
  cache: DraftCache | undefined;
  last: SyncSummary | undefined;
  syncing: boolean;
}) {
  const { cache, last } = props;
  const active = (cache?.drafts ?? [])
    .filter((d) => d.status === 'active')
    .sort((a, b) => b.updatedAt - a.updatedAt);
  return (
    <section class="mt-4" aria-labelledby="drafts-title">
      <h2 id="drafts-title" class="font-semibold text-sm">
        Drafts
      </h2>
      {props.syncing && <p class="text-ink/70 text-xs">Syncing…</p>}
      {last?.rotatedTo !== undefined && (
        <p role="alert" class="mt-2 text-danger text-sm">
          This queue has been rotated to a new key. Pair this device with one that holds it.
        </p>
      )}
      {active.length === 0 ? (
        <p class="mt-2 text-sm">{cache === undefined ? 'Not synced yet.' : 'No active drafts.'}</p>
      ) : (
        <ul class="mt-2 flex flex-col gap-2">
          {active.map((draft) => (
            <DraftItem key={draft.d} draft={draft} />
          ))}
        </ul>
      )}
      {last !== undefined && <SyncNote summary={last} />}
    </section>
  );
}

function DraftItem(props: { draft: CachedDraft }) {
  const { draft } = props;
  return (
    <li class="rounded border border-ink/20 p-2">
      <p class="text-ink/70 text-xs">
        {draft.site} / {draft.account} · {draft.field}
      </p>
      <p class="break-words text-sm">{firstLine(draft.content)}</p>
      {draft.source !== undefined && (
        <p class="text-ink/70 text-xs">from {draft.source.label ?? 'an agent'}</p>
      )}
    </li>
  );
}

function SyncNote(props: { summary: SyncSummary }) {
  const { summary } = props;
  const discarded = discardedTotal(summary);
  return (
    <div class="mt-3 text-ink/70 text-xs">
      <p>
        Last sync: {summary.ingested} new from agents
        {discarded > 0 && `, ${discarded} junk discarded`}
        {summary.deferred > 0 && `, ${summary.deferred} waiting for the next sync`}.
      </p>
      {summary.cappedStreak >= CAP_STREAK_WARNING && (
        <p role="alert" class="mt-1 text-danger">
          The inbox has had more submissions than one sync opens for {summary.cappedStreak} syncs in
          a row. If you didn't expect that many, rotate the inbox key.
        </p>
      )}
      {summary.errors.map((error) => (
        <p key={error}>{error}</p>
      ))}
    </div>
  );
}

/** Asks the background to sync, then shows the cache it wrote. */
export function Drafts(props: { deps: SetupDeps }) {
  const { deps } = props;
  const [cache, setCache] = useState<DraftCache | undefined>();
  const [last, setLast] = useState<SyncSummary | undefined>();
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    let live = true;
    const load = async () => {
      const [c, state] = await Promise.all([
        readDraftCache(deps.store.session),
        readSyncState(deps.store.local),
      ]);
      if (!live) return;
      setCache(c);
      setLast(state.last);
    };
    void load();
    if (deps.requestSync !== undefined) {
      setSyncing(true);
      deps
        .requestSync()
        .catch(() => undefined)
        .then(load)
        .finally(() => live && setSyncing(false));
    }
    return () => {
      live = false;
    };
  }, [deps]);

  return <DraftList cache={cache} last={last} syncing={syncing} />;
}

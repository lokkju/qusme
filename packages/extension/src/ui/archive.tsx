/**
 * The archive view (spec 7.1, 11.4): drafts that were inserted or dismissed, newest first, each
 * with Restore, which sets it back to `active` and keeps its `inserted` tags. It lists the
 * session's decrypted cache from the last sync, like the home screen, and asks for a sync on open.
 * The view says how long archived drafts are kept (7.2, 9.2; 90 days unless Settings changed it,
 * D30), and a draft past it (which the next sync deletes) shows that in place of Restore. A draft
 * the default spares for its first week (D30) keeps Restore and says when it goes.
 * Draft text and agent labels are JSX text children, which Preact sets as text.
 */
import { useCallback, useEffect, useState } from 'preact/hooks';
import { restoreDraft } from '../drafts/manage.ts';
import { inGrace, pastRetention } from '../drafts/retention.ts';
import type { SetupDeps } from '../setup/deps.ts';
import { type CachedDraft, readDraftCache } from '../sync/state.ts';
import { messageOf } from './app.tsx';
import { Button, ErrorText, Screen } from './components.tsx';
import { firstLine } from './drafts.tsx';

/** The archived drafts, most recently changed first. */
export function archivedDrafts(drafts: readonly CachedDraft[]): CachedDraft[] {
  return drafts.filter((d) => d.status !== 'active').sort((a, b) => b.updatedAt - a.updatedAt);
}

const dateOf = (unix: number): string =>
  new Date(unix * 1000).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });

function ArchivedRow(props: {
  draft: CachedDraft;
  busy: boolean;
  expired: boolean;
  /** When the default's grace period ends, for a draft past retention it still spares. */
  graceUntil?: number | undefined;
  onRestore: (draft: CachedDraft) => void;
}) {
  const { draft } = props;
  const [open, setOpen] = useState(false);
  const preview = firstLine(draft.content);
  const more = preview !== draft.content.trim();
  return (
    <li class="card p-3" data-draft={draft.d}>
      <p class="text-muted text-xs">
        {draft.site} / {draft.account} · {draft.field}
        {draft.source !== undefined && ` · from ${draft.source.label ?? 'an agent'}`}
      </p>
      <p class="text-muted text-xs">
        {draft.status === 'archived:inserted' ? 'Inserted' : 'Dismissed'} {dateOf(draft.updatedAt)}
      </p>
      {props.graceUntil !== undefined && (
        <p class="text-muted text-xs">
          Older than the retention; deleted after {dateOf(props.graceUntil)} unless restored.
        </p>
      )}
      {open ? (
        <p class="mt-1 whitespace-pre-wrap break-words text-sm">{draft.content}</p>
      ) : (
        <p class="mt-1 break-words text-sm">{preview}</p>
      )}
      <div class="mt-2 flex items-center justify-end gap-2">
        {more && (
          <button
            type="button"
            class="mr-auto text-xs link"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            {open ? 'Less' : 'Show all'}
          </button>
        )}
        {props.expired ? (
          <p class="text-muted text-xs">Past retention; deleted on the next sync.</p>
        ) : (
          <Button
            variant="plain"
            size="sm"
            disabled={props.busy}
            onClick={() => props.onRestore(draft)}
          >
            Restore
          </Button>
        )}
      </div>
    </li>
  );
}

/** What the archive says about retention (D30), or nothing before the first sync. */
export function retentionNote(cache: { retentionDays?: number | null } | undefined): string {
  if (cache === undefined || cache.retentionDays === undefined) return '';
  const days = cache.retentionDays;
  if (days === null) return 'Archived drafts are never deleted (change in Settings).';
  return `Archived drafts are kept ${days} ${days === 1 ? 'day' : 'days'} (change in Settings).`;
}

/** The list's markup, separate from its effects so it renders in tests. */
export function ArchiveList(props: {
  drafts: CachedDraft[] | undefined;
  busy: boolean;
  onRestore: (draft: CachedDraft) => void;
  /** The effective `archive_retention_days`; `null` or absent keeps every draft. */
  retentionDays?: number | null;
  /** When the default's grace period ends (D30); nothing is past retention before it. */
  graceUntil?: number | undefined;
  /** Unix seconds; defaults to the clock. */
  now?: number;
}) {
  const now = props.now ?? Math.floor(Date.now() / 1000);
  if (props.drafts === undefined) return <p class="mt-2 text-sm">Not synced yet.</p>;
  const archived = archivedDrafts(props.drafts);
  if (archived.length === 0) return <p class="mt-2 text-sm">No archived drafts.</p>;
  return (
    <ul class="mt-2 flex flex-col gap-2">
      {archived.map((draft) => (
        <ArchivedRow
          key={draft.d}
          draft={draft}
          busy={props.busy}
          expired={pastRetention(draft, props.retentionDays, now, props.graceUntil)}
          graceUntil={
            inGrace(draft, props.retentionDays, now, props.graceUntil)
              ? props.graceUntil
              : undefined
          }
          onRestore={props.onRestore}
        />
      ))}
    </ul>
  );
}

export function ArchiveScreen(props: { deps: SetupDeps; onBack: () => void }) {
  const { deps } = props;
  const [drafts, setDrafts] = useState<CachedDraft[] | undefined>();
  const [days, setDays] = useState<number | null>(null);
  const [grace, setGrace] = useState<number | undefined>();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    const cache = await readDraftCache(deps.store.session);
    setDrafts(cache?.drafts);
    setDays(cache?.retentionDays ?? null);
    setGrace(cache?.retentionGraceUntil);
    setNote(retentionNote(cache));
  }, [deps]);
  useEffect(() => {
    let live = true;
    void load();
    deps
      .requestSync?.()
      .catch(() => undefined)
      .then(async () => {
        if (live) await load();
      });
    return () => {
      live = false;
    };
  }, [load, deps]);

  const restore = async (draft: CachedDraft) => {
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      await restoreDraft(draft.d, deps);
      setNotice(`Restored "${firstLine(draft.content)}" to your drafts.`);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
      await load();
    }
  };

  return (
    <Screen title="Archive" onBack={props.onBack}>
      <p class="mt-2 text-muted text-xs">
        Drafts you inserted or dismissed. Restore puts one back in your drafts.
        {note !== '' && ` ${note}`}
      </p>
      <ArchiveList
        drafts={drafts}
        busy={busy}
        retentionDays={days}
        graceUntil={grace}
        onRestore={(d) => void restore(d)}
      />
      {notice !== undefined && (
        <p role="status" class="mt-3 text-sm">
          {notice}
        </p>
      )}
      <ErrorText message={error} />
    </Screen>
  );
}

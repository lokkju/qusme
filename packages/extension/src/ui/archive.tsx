/**
 * The archive view (spec 7.1, 11.4): drafts that were inserted or dismissed, newest first, each
 * with Restore, which sets it back to `active` and keeps its `inserted` tags. It lists the
 * session's decrypted cache from the last sync, like the home screen, and asks for a sync on open.
 * Draft text and agent labels are JSX text children, which Preact sets as text.
 */
import { useCallback, useEffect, useState } from 'preact/hooks';
import { restoreDraft } from '../drafts/manage.ts';
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
  onRestore: (draft: CachedDraft) => void;
}) {
  const { draft } = props;
  const [open, setOpen] = useState(false);
  const preview = firstLine(draft.content);
  const more = preview !== draft.content.trim();
  return (
    <li class="rounded border border-ink/20 p-2" data-draft={draft.d}>
      <p class="text-ink/70 text-xs">
        {draft.site} / {draft.account} · {draft.field}
        {draft.source !== undefined && ` · from ${draft.source.label ?? 'an agent'}`}
      </p>
      <p class="text-ink/70 text-xs">
        {draft.status === 'archived:inserted' ? 'Inserted' : 'Dismissed'} {dateOf(draft.updatedAt)}
      </p>
      {open ? (
        <p class="mt-1 whitespace-pre-wrap break-words text-sm">{draft.content}</p>
      ) : (
        <p class="mt-1 break-words text-sm">{preview}</p>
      )}
      <div class="mt-2 flex items-center justify-end gap-2">
        {more && (
          <button
            type="button"
            class="mr-auto text-xs underline"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            {open ? 'Less' : 'Show all'}
          </button>
        )}
        <Button
          variant="plain"
          class="px-3 py-1 text-sm"
          disabled={props.busy}
          onClick={() => props.onRestore(draft)}
        >
          Restore
        </Button>
      </div>
    </li>
  );
}

/** The list's markup, separate from its effects so it renders in tests. */
export function ArchiveList(props: {
  drafts: CachedDraft[] | undefined;
  busy: boolean;
  onRestore: (draft: CachedDraft) => void;
}) {
  if (props.drafts === undefined) return <p class="mt-2 text-sm">Not synced yet.</p>;
  const archived = archivedDrafts(props.drafts);
  if (archived.length === 0) return <p class="mt-2 text-sm">No archived drafts.</p>;
  return (
    <ul class="mt-2 flex flex-col gap-2">
      {archived.map((draft) => (
        <ArchivedRow key={draft.d} draft={draft} busy={props.busy} onRestore={props.onRestore} />
      ))}
    </ul>
  );
}

export function ArchiveScreen(props: { deps: SetupDeps; onBack: () => void }) {
  const { deps } = props;
  const [drafts, setDrafts] = useState<CachedDraft[] | undefined>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    setDrafts((await readDraftCache(deps.store.session))?.drafts);
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
    <Screen title="Archived drafts" onBack={props.onBack}>
      <p class="mt-2 text-ink/70 text-xs">
        Drafts you inserted or dismissed. Restore puts one back in your drafts.
      </p>
      <ArchiveList drafts={drafts} busy={busy} onRestore={(d) => void restore(d)} />
      {notice !== undefined && (
        <p role="status" class="mt-3 text-sm">
          {notice}
        </p>
      )}
      <ErrorText message={error} />
    </Screen>
  );
}

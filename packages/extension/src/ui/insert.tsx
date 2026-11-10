/**
 * The popup's draft list (spec 11.4, 11.5): one list grouped "For this page" (destination match
 * and detected account) and "Elsewhere". On open it asks the background to sync, reads the active
 * tab (activeTab) and runs the read-only account detection there. Each row expands to its full
 * text and has an Insert button that inserts it in one click; "Arm for right-click" keeps the
 * context menu path. Each row can also be edited and dismissed (spec 7.1), and a dismissal or an
 * insertion can be undone from the status line for as long as the popup stays open (UX audit
 * 5.5, 6.5). Draft selection happens here, in extension origin: only the inserted draft's text
 * ever reaches the page. Every draft string is a JSX text child, which Preact sets as text.
 */
import type { SiteAccount } from '@qusme/nostr';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { addDestination } from '../agents/destinations.ts';
import { dismissDraft, editDraft, restoreDraft } from '../drafts/manage.ts';
import { type ArmedDraft, arm, disarm, readArmed, readInsertionState } from '../insertion/armed.ts';
import { definitionSource, type SiteDefinitionSource } from '../insertion/definitions.ts';
import { type DestinationOffer, destinationOffers, registrySitesOn } from '../insertion/detect.ts';
import {
  accountLocators,
  draftsForPage,
  type PageDraft,
  type PageDrafts,
} from '../insertion/matching.ts';
import type { InsertResponse } from '../insertion/service.ts';
import type { KeyStore } from '../keyStore.ts';
import type { SetupDeps } from '../setup/deps.ts';
import { readDraftCache, readSyncState, type SyncSummary } from '../sync/state.ts';
import { messageOf } from './app.tsx';
import { Button, inputClass } from './components.tsx';
import { firstLine, SyncNote } from './drafts.tsx';

/** What the panel needs from the browser; absent in tests of the rest of the popup. */
export interface InsertionUiDeps {
  definitions: SiteDefinitionSource;
  /** The active tab, readable after the popup opened under activeTab. */
  activeTab(): Promise<{ id: number; url: string } | undefined>;
  detectAccounts(tabId: number, locators: readonly SiteAccount[]): Promise<(string | undefined)[]>;
  /** Asks the background to insert the chosen draft into the tab, without arming it. */
  insert(tabId: number, d: string): Promise<InsertResponse>;
  retryRecord(): Promise<{ remaining: number; messages: string[] }>;
  writeClipboard(text: string): Promise<boolean>;
  /** Calls back when the session's drafts or armed draft change; returns the unsubscribe. */
  onSessionChange?(callback: () => void): () => void;
  /** Ctrl+V or ⌘V, for the paste prompt. */
  pasteShortcut?: string;
  /** The picker command's current binding (Alt+Q unless rebound); empty when it has none. */
  pickerShortcut?(): Promise<string>;
}

/** What the user should read after an insert, written for them. */
export function insertMessage(response: InsertResponse, shortcut = 'Ctrl+V'): string {
  switch (response.state) {
    case 'inserted':
      return response.recorded
        ? `Inserted (${response.strategy}). The draft is archived.`
        : `Inserted (${response.strategy}), but not recorded yet: ${response.message ?? 'try again'}`;
    case 'waiting':
      return response.reason === 'focus'
        ? 'Click into the field where the draft should go.'
        : `The draft is on the clipboard. Click into the field and press ${shortcut}.`;
    case 'not_armed':
      return 'Pick a draft first.';
    case 'not_found':
      return "That draft isn't in the queue any more.";
    case 'locked':
      return 'Unlock the queue first.';
    case 'failed':
      switch (response.reason) {
        case 'partial':
          return "The field changed but doesn't match the draft. Check it before posting.";
        case 'exhausted':
          return "This field didn't take the draft.";
        case 'clipboard_denied':
          return "The draft couldn't be copied to the clipboard.";
        case 'empty':
          return 'This draft is empty.';
        case 'injection':
          return response.message ?? 'qus.me could not run in this page.';
        default:
          return 'The insertion stopped.';
      }
  }
}

interface ViewProps {
  /** The active tab's URL when qus.me can use the tab; undefined hides "For this page". */
  url: string | undefined;
  page: PageDrafts | undefined;
  /** Whether the session holds a synced draft cache yet. */
  synced?: boolean;
  syncing?: boolean;
  last?: SyncSummary | undefined;
  /** Sites with an account locator where detection found nothing. */
  undetected: string[];
  armed: ArmedDraft | undefined;
  status: string | undefined;
  unrecorded: number;
  busy: boolean;
  /** Detected accounts on registry sites with no destination yet (spec 7.2). */
  offers?: DestinationOffer[];
  /** The picker shortcut for the hint; empty when unbound, undefined when not known. */
  pickerShortcut?: string | undefined;
  onAddOffer?(offer: DestinationOffer): void;
  /** Inserts the row's draft into the tab in one click (spec 11.5). */
  onInsert(entry: PageDraft): void;
  /** Arms the row's draft for the context menu. */
  onArm(entry: PageDraft): void;
  onDisarm(): void;
  onRetry(): void;
  /** Saves new text for the row's draft; resolves true when saved, so the editor closes. */
  onEdit?(entry: PageDraft, content: string): Promise<boolean>;
  /** Archives the row's draft as dismissed. */
  onDismiss?(entry: PageDraft): void;
  /** An Undo for the status line: restores the draft just dismissed or inserted. */
  onUndo?: (() => void) | undefined;
  /** Opens the pairing screen, for the rotated-queue notice. */
  onPair?: (() => void) | undefined;
  /** Opens the agents screen, for the flood warning. */
  onAgents?: (() => void) | undefined;
  /** Opens the swap screen for a storage relay that accepts nothing (9.1). */
  onReplaceRelay?: ((url: string) => void) | undefined;
}

function DraftRow(props: {
  entry: PageDraft;
  armed: boolean;
  showAccount: boolean;
  /** False on a tab qus.me can't use: the row offers no Insert. */
  insertable: boolean;
  busy: boolean;
  onInsert: (entry: PageDraft) => void;
  onArm: (entry: PageDraft) => void;
  onEdit?: ((entry: PageDraft, content: string) => Promise<boolean>) | undefined;
  onDismiss?: ((entry: PageDraft) => void) | undefined;
}) {
  const { draft } = props.entry;
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<string | undefined>();
  const preview = firstLine(draft.content);
  // Expanding shows something only when the preview cut the text.
  const more = preview !== draft.content.trim();
  const header = (
    <p class="text-ink/70 text-xs">
      {draft.site}
      {props.showAccount && ` / ${draft.account}`} · {draft.field}
      {draft.source !== undefined && ` · from ${draft.source.label ?? 'an agent'}`}
    </p>
  );
  if (editing !== undefined && props.onEdit !== undefined) {
    const save = props.onEdit;
    const id = `edit-${draft.d}`;
    return (
      <li class="rounded border border-accent p-2" data-draft={draft.d}>
        {header}
        <label for={id} class="sr-only">
          Draft text
        </label>
        <textarea
          id={id}
          class={`${inputClass} mt-1 min-h-24`}
          value={editing}
          onInput={(e) => setEditing(e.currentTarget.value)}
        />
        <div class="mt-2 flex justify-end gap-2">
          <Button variant="plain" class="px-2 py-1 text-sm" onClick={() => setEditing(undefined)}>
            Cancel
          </Button>
          <Button
            class="px-3 py-1 text-sm"
            disabled={props.busy || editing.trim() === '' || editing === draft.content}
            onClick={async () => {
              if (await save(props.entry, editing)) setEditing(undefined);
            }}
          >
            Save
          </Button>
        </div>
      </li>
    );
  }
  return (
    <li class="rounded border border-ink/20 p-2" data-draft={draft.d}>
      {header}
      {open ? (
        <p class="mt-1 whitespace-pre-wrap break-words text-sm">{draft.content}</p>
      ) : (
        <p class="mt-1 break-words text-sm">{preview}</p>
      )}
      <div class="mt-2 flex flex-wrap items-center justify-end gap-2">
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
        {props.onEdit !== undefined && (
          <button
            type="button"
            class={`${more ? '' : 'mr-auto '}text-xs underline`}
            disabled={props.busy}
            onClick={() => setEditing(draft.content)}
          >
            Edit
          </button>
        )}
        {props.onDismiss !== undefined && (
          <button
            type="button"
            class="text-xs underline"
            disabled={props.busy}
            onClick={() => props.onDismiss?.(props.entry)}
          >
            Dismiss
          </button>
        )}
        {props.armed ? (
          <span class="text-ink/70 text-xs">Armed for right-click</span>
        ) : (
          open &&
          props.insertable && (
            <Button
              variant="plain"
              class="px-2 py-1 text-xs"
              onClick={() => props.onArm(props.entry)}
            >
              Arm for right-click
            </Button>
          )
        )}
        {props.insertable && (
          <Button
            class="px-3 py-1 text-sm"
            disabled={props.busy}
            onClick={() => props.onInsert(props.entry)}
          >
            Insert
          </Button>
        )}
      </div>
    </li>
  );
}

/** The panel's markup, separate from its effects so it renders in tests. */
export function InsertView(props: ViewProps) {
  const { page, armed } = props;
  const detected = Object.entries(page?.detected ?? {});
  const onPage = props.url !== undefined;
  const synced = props.synced ?? page !== undefined;
  const matching = onPage ? (page?.matching ?? []) : [];
  const elsewhere = page?.elsewhere ?? [];
  const row = (entry: PageDraft, showAccount: boolean) => (
    <DraftRow
      key={entry.draft.d}
      entry={entry}
      armed={armed?.d === entry.draft.d}
      showAccount={showAccount}
      insertable={onPage}
      busy={props.busy}
      onInsert={props.onInsert}
      onArm={props.onArm}
      onEdit={props.onEdit}
      onDismiss={props.onDismiss}
    />
  );
  return (
    <div class="mt-4 flex flex-col gap-4">
      {onPage && (
        <section aria-labelledby="this-page-title">
          <h2 id="this-page-title" class="font-semibold text-sm">
            For this page
          </h2>
          {props.pickerShortcut !== undefined && (
            <p class="mt-1 text-ink/70 text-xs">
              {props.pickerShortcut === ''
                ? "Give qus.me a keyboard shortcut in your browser's extension shortcuts to pick drafts from any text field."
                : `Press ${props.pickerShortcut} in any text field to pick a draft there.`}
            </p>
          )}
          {detected.map(([site, account]) => (
            <p key={site} class="mt-1 text-ink/70 text-xs">
              Signed in to {site} as {account}.
            </p>
          ))}
          {(props.offers ?? []).map((offer) => (
            <div key={`${offer.site}:${offer.account}`} class="mt-2">
              <Button
                variant="plain"
                class="px-2 py-1 text-xs"
                disabled={props.busy}
                onClick={() => props.onAddOffer?.(offer)}
              >
                Add {offer.account} on {offer.siteName} as a destination
              </Button>
            </div>
          ))}
          {props.undetected.map((site) => (
            <p key={site} class="mt-1 text-ink/70 text-xs">
              Couldn't tell which {site} account is signed in; showing drafts for every account.
            </p>
          ))}
          {matching.length === 0 ? (
            <p class="mt-2 text-sm">{synced ? 'No drafts for this page.' : 'Not synced yet.'}</p>
          ) : (
            <ul class="mt-2 flex flex-col gap-2">
              {matching.map((entry) => row(entry, page?.detected[entry.draft.site] === undefined))}
            </ul>
          )}
          {page !== undefined && page.otherAccounts > 0 && (
            <p class="mt-1 text-ink/70 text-xs">
              {page.otherAccounts} draft{page.otherAccounts === 1 ? '' : 's'} for other accounts
              hidden.
            </p>
          )}
        </section>
      )}
      {(elsewhere.length > 0 || !onPage) && (
        <section aria-labelledby="elsewhere-title">
          <h2 id="elsewhere-title" class="font-semibold text-sm">
            {onPage ? 'Elsewhere' : 'Drafts'}
            {elsewhere.length > 0 && (
              <span class="ml-2 font-normal text-ink/70 text-xs">
                {elsewhere.length} draft{elsewhere.length === 1 ? '' : 's'}
              </span>
            )}
          </h2>
          {elsewhere.length === 0 ? (
            <p class="mt-2 text-sm">{synced ? 'No active drafts.' : 'Not synced yet.'}</p>
          ) : (
            <ul class="mt-2 flex flex-col gap-2">{elsewhere.map((entry) => row(entry, true))}</ul>
          )}
        </section>
      )}
      {props.syncing && <p class="text-ink/70 text-xs">Syncing…</p>}
      {armed !== undefined && (
        <div class="rounded border border-accent p-2">
          <p class="text-xs">Armed for right-click:</p>
          <p class="break-words text-sm">{firstLine(armed.content)}</p>
          <p class="mt-1 text-ink/70 text-xs">
            Right-click a field on the destination's page and choose Insert.
          </p>
          <Button variant="plain" class="mt-2 px-2 py-1 text-sm" onClick={props.onDisarm}>
            Disarm
          </Button>
        </div>
      )}
      {props.status !== undefined && (
        <p role="status" class="text-sm">
          {props.status}
          {props.onUndo !== undefined && (
            <>
              {' '}
              <button type="button" class="underline" disabled={props.busy} onClick={props.onUndo}>
                Undo
              </button>
            </>
          )}
        </p>
      )}
      {props.unrecorded > 0 && (
        <p class="text-danger text-xs">
          {props.unrecorded} insertion{props.unrecorded === 1 ? '' : 's'} not recorded on the relays
          yet.{' '}
          <button type="button" class="underline" onClick={props.onRetry}>
            Retry
          </button>
        </p>
      )}
      {props.last !== undefined && (
        <SyncNote
          summary={props.last}
          onPair={props.onPair}
          onAgents={props.onAgents}
          onReplaceRelay={props.onReplaceRelay}
        />
      )}
    </div>
  );
}

/**
 * The home screen's draft list with its effects: the sync on open, the tab and the account
 * detection, one-click insert and arming for the context menu. Without `deps` (tests of the rest
 * of the popup, or no tab) it lists the drafts with no Insert.
 */
export function InsertPanel(props: {
  store: KeyStore;
  deps?: InsertionUiDeps | undefined;
  /** For the sync on open, the add-destination shortcut and changing drafts. */
  setup?: SetupDeps;
  onPair?: () => void;
  onAgents?: () => void;
  onReplaceRelay?: (url: string) => void;
}) {
  const { store, deps, setup } = props;
  const [tab, setTab] = useState<{ id: number; url: string } | undefined>();
  const [page, setPage] = useState<PageDrafts | undefined>();
  const [synced, setSynced] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [last, setLast] = useState<SyncSummary | undefined>();
  const [undetected, setUndetected] = useState<string[]>([]);
  const [armed, setArmed] = useState<ArmedDraft | undefined>();
  const [status, setStatus] = useState<string>();
  const [unrecorded, setUnrecorded] = useState(0);
  const [busy, setBusy] = useState(false);
  const [offers, setOffers] = useState<DestinationOffer[]>([]);
  const [pickerShortcut, setPickerShortcut] = useState<string | undefined>();
  // The draft the status line can bring back: just dismissed, or just inserted and recorded.
  const [undoable, setUndoable] = useState<string | undefined>();
  // The tab and the detected accounts are read once per popup open.
  const tabRef = useRef<Promise<{ id: number; url: string } | undefined> | undefined>(undefined);
  const detectedRef = useRef<
    | Promise<{
        found: Record<string, string>;
        undetected: string[];
        registry: ReturnType<typeof registrySitesOn>;
      }>
    | undefined
  >(undefined);

  const load = useCallback(async () => {
    tabRef.current ??= deps?.activeTab().catch(() => undefined) ?? Promise.resolve(undefined);
    const [cache, sync, currentArmed, insertion, active] = await Promise.all([
      readDraftCache(store.session),
      readSyncState(store.local),
      readArmed(store.session),
      readInsertionState(store.session),
      tabRef.current,
    ]);
    setSynced(cache !== undefined);
    setLast(sync.last);
    setArmed(currentArmed);
    setUnrecorded(insertion.unrecorded.length);
    setTab(active);
    const drafts = cache?.drafts ?? [];
    const destinations = cache?.destinations ?? [];
    const url = active?.url ?? '';
    if (deps !== undefined && active !== undefined && cache !== undefined) {
      // Step 2: one read-only detection per site among the drafts for this page.
      detectedRef.current ??= (async () => {
        const locators = accountLocators(drafts, destinations, deps.definitions, url);
        const draftSites = [...locators.keys()];
        // Registry sites on this page too, for the add-destination shortcut.
        const registry = setup === undefined ? [] : registrySitesOn(deps.definitions, url);
        for (const site of registry) {
          if (!locators.has(site.id) && site.account) locators.set(site.id, site.account);
        }
        const sites = [...locators.keys()];
        const results = await deps
          .detectAccounts(active.id, [...locators.values()])
          .catch(() => [] as (string | undefined)[]);
        const found: Record<string, string> = {};
        for (const [i, site] of sites.entries()) {
          const account = results[i];
          if (typeof account === 'string' && account !== '') found[site] = account;
        }
        return {
          found,
          undetected: draftSites.filter((s) => found[s] === undefined),
          registry,
        };
      })();
    }
    const detection = await detectedRef.current;
    setUndetected(detection?.undetected ?? []);
    setOffers(
      detection === undefined
        ? []
        : destinationOffers(detection.registry, detection.found, destinations)
    );
    setPage(
      draftsForPage({
        drafts,
        destinations,
        source: deps?.definitions ?? definitionSource(),
        url,
        detected: detection?.found ?? {},
      })
    );
  }, [store, deps, setup]);

  useEffect(() => {
    let live = true;
    void load();
    // Opening the popup syncs (spec 11.4); the list shows the cache meanwhile.
    if (setup?.requestSync !== undefined) {
      setSyncing(true);
      setup
        .requestSync()
        .catch(() => undefined)
        .then(async () => {
          if (live) await load();
        })
        .finally(() => live && setSyncing(false));
    }
    const unsubscribe = deps?.onSessionChange?.(() => void load());
    return () => {
      live = false;
      unsubscribe?.();
    };
  }, [load, deps, setup]);
  useEffect(() => {
    void deps
      ?.pickerShortcut?.()
      .then(setPickerShortcut)
      .catch(() => undefined);
  }, [deps]);

  const onArm = async (entry: PageDraft) => {
    setStatus(undefined);
    setUndoable(undefined);
    setArmed(await arm(store.session, entry.draft, Math.floor(Date.now() / 1000)));
  };
  const onDisarm = async () => {
    await disarm(store.session);
    setArmed(undefined);
  };
  // One click: the background inserts this draft without arming it (the popup's click granted
  // activeTab), so a failure leaves nothing armed.
  const onInsert = async (entry: PageDraft) => {
    if (deps === undefined || tab === undefined) return;
    setBusy(true);
    setStatus(undefined);
    setUndoable(undefined);
    const { content } = entry.draft;
    try {
      const response = await deps.insert(tab.id, entry.draft.d);
      // The page could not write the clipboard; the popup can, inside the user's click.
      if (
        response.state === 'waiting' &&
        response.reason === 'paste' &&
        response.clipboardWritten === false
      ) {
        const written = await deps.writeClipboard(content);
        setStatus(
          written
            ? insertMessage(response, deps.pasteShortcut)
            : insertMessage({ state: 'failed', reason: 'clipboard_denied' })
        );
      } else {
        setStatus(insertMessage(response, deps.pasteShortcut));
        if (response.state === 'inserted' && response.recorded) setUndoable(entry.draft.d);
      }
    } catch (error) {
      setStatus(`The insertion failed: ${(error as Error)?.message ?? String(error)}`);
    } finally {
      setBusy(false);
      await load();
    }
  };
  const onAddOffer = async (offer: DestinationOffer) => {
    if (setup === undefined || deps === undefined) return;
    setBusy(true);
    setStatus(undefined);
    try {
      const added = await addDestination(
        { site: offer.site, account: offer.account, override: null },
        deps.definitions,
        setup
      );
      setStatus(`Added ${added.label}.`);
      void setup.requestSync?.().catch(() => undefined);
    } catch (error) {
      setStatus(messageOf(error));
    } finally {
      setBusy(false);
      await load();
    }
  };
  // Edit, dismiss and undo change the draft on every storage relay, so they need the setup deps.
  const change = async (action: () => Promise<string>, undo?: string): Promise<boolean> => {
    if (setup === undefined) return false;
    setBusy(true);
    setStatus(undefined);
    setUndoable(undefined);
    try {
      setStatus(await action());
      setUndoable(undo);
      return true;
    } catch (error) {
      setStatus(messageOf(error));
      return false;
    } finally {
      setBusy(false);
      await load();
    }
  };
  const onEdit = (entry: PageDraft, content: string) =>
    change(async () => {
      await editDraft(entry.draft.d, content, setup as SetupDeps, deps?.definitions);
      return 'Saved.';
    });
  const onDismiss = (entry: PageDraft) =>
    void change(async () => {
      await dismissDraft(entry.draft.d, setup as SetupDeps);
      return 'Dismissed. It is in Archived drafts.';
    }, entry.draft.d);
  const onUndo = (d: string) =>
    void change(async () => {
      await restoreDraft(d, setup as SetupDeps);
      return 'Restored.';
    });
  const onRetry = async () => {
    if (deps === undefined) return;
    const result = await deps.retryRecord();
    setStatus(result.remaining === 0 ? 'Recorded.' : (result.messages[0] ?? 'Still not recorded.'));
    await load();
  };

  return (
    <InsertView
      url={deps === undefined ? undefined : tab?.url}
      page={page}
      synced={synced}
      syncing={syncing}
      last={last}
      undetected={undetected}
      armed={armed}
      status={status}
      unrecorded={unrecorded}
      busy={busy}
      offers={offers}
      pickerShortcut={pickerShortcut}
      onAddOffer={(o) => void onAddOffer(o)}
      onInsert={(e) => void onInsert(e)}
      onArm={(e) => void onArm(e)}
      onDisarm={() => void onDisarm()}
      onRetry={() => void onRetry()}
      {...(setup !== undefined && { onEdit, onDismiss })}
      onUndo={undoable === undefined ? undefined : () => onUndo(undoable)}
      onPair={props.onPair}
      onAgents={props.onAgents}
      onReplaceRelay={props.onReplaceRelay}
    />
  );
}

/**
 * The popup's home list (spec 11.4, 11.5): "N drafts" in the serif, accounts an agent is waiting
 * on, then one list grouped "For this page" (destination match and detected account) and
 * "Elsewhere". On open it asks the background to sync, reads the active tab (activeTab) and runs
 * the read-only account detection there. A row for this page inserts in one click; expanding a
 * row offers Edit, Dismiss (spec 7.1) and "Set for right-click", the context menu path, and on a
 * row for another site "Insert here anyway" (`draftRow.tsx`). A dismissal or an insertion can be
 * undone from the status line for as long as the popup stays open (UX audit 5.5, 6.5). Draft
 * selection happens here, in extension origin: only the inserted draft's text ever reaches the
 * page. Every draft string is a JSX text child, which Preact sets as text.
 */
import { type Destination, displayAccount, type SiteAccount } from '@qusme/nostr';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import {
  addDestination,
  confirmPendingDestination,
  rejectPendingDestination,
} from '../agents/destinations.ts';
import { dismissDraft, editDraft, restoreDraft } from '../drafts/manage.ts';
import { destinationLabel, rowData } from '../drafts/row.ts';
import { relativeTime } from '../drafts/rowFormat.ts';
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
import {
  type CachedDraft,
  readDraftCache,
  readSyncState,
  type SyncSummary,
} from '../sync/state.ts';
import { dismissPickerTip, pickerTipDismissed } from '../tips.ts';
import { messageOf } from './app.tsx';
import { Button } from './components.tsx';
import { DraftRow } from './draftRow.tsx';
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

/** What the user should read after an insert, written for them (critique R5). */
export function insertMessage(response: InsertResponse, shortcut = 'Ctrl+V'): string {
  switch (response.state) {
    case 'inserted':
      return response.recorded
        ? 'Inserted. Check it, then post.'
        : "Inserted. Check it, then post. It couldn't be marked done yet, so it may show again on your other devices.";
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

/** The raw reason behind an insert outcome, for the status line's Details; undefined for none. */
export function insertDetail(response: InsertResponse): string | undefined {
  if (response.state === 'inserted' && !response.recorded) return response.message;
  return undefined;
}

/** The toolbar's context chip: the page's host and the detected account (H3), else nothing. */
export function pageChip(
  url: string | undefined,
  detected: Record<string, string>
): string | undefined {
  if (url === undefined) return undefined;
  let host: string;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return undefined;
    host = parsed.hostname.replace(/^www\./, '');
  } catch {
    return undefined;
  }
  const account = Object.values(detected)[0];
  return account === undefined ? host : `${host} · ${displayAccount(account)}`;
}

/** An account an agent proposed and is waiting on (A7), with what it already sent there. */
export interface PendingCard {
  destination: Destination;
  /** The one destination format (drafts/row.ts). */
  label: string;
  /** The agent whose drafts wait for it, when the cache says. */
  agent?: string;
  drafts: number;
}

/** The pending destinations in the cache, each with its agent and its waiting drafts. */
export function pendingCards(
  drafts: readonly CachedDraft[],
  destinations: readonly Destination[],
  source: SiteDefinitionSource
): PendingCard[] {
  return destinations
    .filter((d) => d.status === 'pending')
    .map((destination) => {
      const waiting = drafts.filter(
        (draft) => draft.destination === destination.id && draft.status === 'active'
      );
      const agent = waiting.find((draft) => draft.source?.label !== undefined)?.source?.label;
      return {
        destination,
        label: destinationLabel(source, destination.site, destination.account, destination),
        ...(agent !== undefined && { agent }),
        drafts: waiting.length,
      };
    });
}

function PendingDestination(props: {
  card: PendingCard;
  busy: boolean;
  onAllow: (d: Destination) => void;
  onReject: (d: Destination) => void;
}) {
  const { card } = props;
  const [rejecting, setRejecting] = useState(false);
  const waiting = `${card.drafts} draft${card.drafts === 1 ? '' : 's'} waiting.`;
  return (
    <li class="card-tint p-3 text-sm">
      <p>
        {card.agent ?? 'An agent'} wants to draft for{' '}
        <span class="font-semibold">{card.label}</span>.{' '}
        <span class="text-muted text-xs">{waiting}</span>
      </p>
      {rejecting ? (
        <div class="mt-2">
          <p class="text-xs">
            Rejecting also dismisses {card.drafts === 1 ? 'its draft' : `its ${card.drafts} drafts`}
            .
          </p>
          <div class="mt-1 flex gap-2">
            <Button
              variant="danger"
              size="sm"
              disabled={props.busy}
              onClick={() => props.onReject(card.destination)}
            >
              Reject
            </Button>
            <Button variant="plain" size="sm" onClick={() => setRejecting(false)}>
              Keep
            </Button>
          </div>
        </div>
      ) : (
        <div class="mt-2 flex gap-2">
          <Button size="sm" disabled={props.busy} onClick={() => props.onAllow(card.destination)}>
            Allow
          </Button>
          <Button
            variant="plain"
            size="sm"
            disabled={props.busy}
            onClick={() =>
              card.drafts === 0 ? props.onReject(card.destination) : setRejecting(true)
            }
          >
            Reject
          </Button>
        </div>
      )}
    </li>
  );
}

interface ViewProps {
  /** The active tab's URL when qus.me can use the tab; undefined hides "For this page". */
  url: string | undefined;
  page: PageDrafts | undefined;
  /** For the rows' destinations, lengths and field names; the bundled registry by default. */
  definitions?: SiteDefinitionSource | undefined;
  destinations?: readonly Destination[] | undefined;
  /** Unix seconds, for relative times; the clock by default. */
  now?: number;
  /** When the cache was last synced, for the heading's "updated" line. */
  syncedAt?: number | undefined;
  /** Whether the session holds a synced draft cache yet. */
  synced?: boolean;
  syncing?: boolean;
  last?: SyncSummary | undefined;
  /** Sites with an account locator where detection found nothing. */
  undetected: string[];
  armed: ArmedDraft | undefined;
  status: string | undefined;
  /** Raw reasons behind the status, under a Details disclosure (S3). */
  statusDetails?: string[] | undefined;
  unrecorded: number;
  busy: boolean;
  /** Detected accounts on registry sites with no destination yet (spec 7.2). */
  offers?: DestinationOffer[];
  /** Accounts agents proposed, waiting for the user (A7). */
  pending?: PendingCard[];
  /** The picker shortcut for the tip; empty when unbound, undefined when not known. */
  pickerShortcut?: string | undefined;
  /** Shows the picker tip in the footer (until the picker is first used or the tip closed). */
  tip?: boolean;
  onDismissTip?(): void;
  onAddOffer?(offer: DestinationOffer): void;
  onAllow?(destination: Destination): void;
  onReject?(destination: Destination): void;
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
  /** Runs the sync again, for the sync error line. */
  onSync?: (() => void) | undefined;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const groupLabel = 'pt-3 pb-1.5 font-semibold text-[11px] text-muted uppercase tracking-[0.08em]';

/** The panel's markup, separate from its effects so it renders in tests. */
export function InsertView(props: ViewProps) {
  const { page, armed } = props;
  const source = props.definitions ?? definitionSource();
  const destinations = props.destinations ?? [];
  const now = props.now ?? Math.floor(Date.now() / 1000);
  const onPage = props.url !== undefined;
  const synced = props.synced ?? page !== undefined;
  const matching = onPage ? (page?.matching ?? []) : [];
  const elsewhere = page?.elsewhere ?? [];
  const total = matching.length + elsewhere.length;
  const pending = props.pending ?? [];
  const row = (entry: PageDraft, isElsewhere: boolean) => (
    <DraftRow
      key={entry.draft.d}
      row={rowData(entry.draft, {
        source,
        destinations,
        now,
        showDestination: isElsewhere || page?.detected[entry.draft.site] === undefined,
      })}
      elsewhere={isElsewhere && onPage}
      insertable={onPage}
      armed={armed?.d === entry.draft.d}
      busy={props.busy}
      onInsert={() => props.onInsert(entry)}
      onArm={() => props.onArm(entry)}
      onEdit={
        props.onEdit &&
        ((content: string) => props.onEdit?.(entry, content) ?? Promise.resolve(false))
      }
      onDismiss={props.onDismiss && (() => props.onDismiss?.(entry))}
    />
  );
  const host = pageChip(props.url, {})?.split(' · ')[0];
  const shortcut = props.pickerShortcut;
  const updated = props.syncing
    ? 'checking for new drafts…'
    : props.syncedAt !== undefined
      ? `updated ${relativeTime(props.syncedAt, now)}`
      : undefined;
  const sub = [onPage && total > 0 ? `${matching.length} for this page` : undefined, updated]
    .filter((part) => part !== undefined)
    .join(' · ');

  const showTip = props.tip === true && shortcut !== undefined;
  return (
    <div class={`flex flex-col ${showTip ? '' : 'pb-4'}`}>
      <div class="flex flex-wrap items-baseline gap-x-2.5 pb-1">
        <h1 id="screen-title" class="font-medium font-serif text-2xl leading-tight">
          {total === 0 ? 'No drafts' : plural(total, 'draft', 'drafts')}
        </h1>
        {sub !== '' && <p class="text-muted text-xs">{sub}</p>}
      </div>
      {pending.length > 0 && (
        <ul class="mt-2 flex flex-col gap-2" aria-label="Accounts waiting for your OK">
          {pending.map((card) => (
            <PendingDestination
              key={card.destination.id}
              card={card}
              busy={props.busy}
              onAllow={(d) => props.onAllow?.(d)}
              onReject={(d) => props.onReject?.(d)}
            />
          ))}
        </ul>
      )}
      {(props.offers ?? []).map((offer) => (
        <div key={`${offer.site}:${offer.account}`} class="mt-2">
          <Button
            variant="plain"
            size="xs"
            disabled={props.busy}
            onClick={() => props.onAddOffer?.(offer)}
          >
            Add {offer.account} on {offer.siteName} to your accounts
          </Button>
        </div>
      ))}
      {total === 0 ? (
        <p class="mt-3 text-ink-2 text-sm">
          {!synced
            ? props.syncing
              ? 'Checking for new drafts…'
              : 'Not synced yet.'
            : `Nothing waiting. Ask your agent to draft something; it shows up here${
                host !== undefined && shortcut
                  ? `, and on ${host} press ${shortcut} in the post box to pick it`
                  : ''
              }.`}
        </p>
      ) : (
        <>
          {onPage && (
            <section aria-labelledby="this-page-title">
              <h2 id="this-page-title" class={groupLabel}>
                For this page
              </h2>
              {props.undetected.map((site) => (
                <p key={site} class="pb-1.5 text-muted text-xs">
                  Couldn't tell which {site} account is signed in; showing drafts for every account.
                </p>
              ))}
              {matching.length === 0 ? (
                <p class="pb-2 text-sm">No drafts for this page.</p>
              ) : (
                <ul class="-mx-4 border-line border-t">{matching.map((e) => row(e, false))}</ul>
              )}
              {page !== undefined && page.otherAccounts > 0 && (
                <p class="pt-1.5 text-muted text-xs">
                  {plural(page.otherAccounts, 'draft', 'drafts')} for other accounts hidden.
                </p>
              )}
            </section>
          )}
          {elsewhere.length > 0 && (
            <section aria-labelledby="elsewhere-title">
              <h2 id="elsewhere-title" class={onPage ? groupLabel : 'sr-only'}>
                {onPage ? 'Elsewhere' : 'Drafts'}
              </h2>
              <ul class={`-mx-4 border-line border-t ${onPage ? '' : 'mt-2'}`}>
                {elsewhere.map((e) => row(e, true))}
              </ul>
            </section>
          )}
        </>
      )}
      {armed !== undefined && (
        <div class="mt-3 card-accent p-3">
          <p class="text-xs">Set for right-click:</p>
          <p class="break-words text-sm">{firstLine(armed.content)}</p>
          <p class="mt-1 text-muted text-xs">
            Right-click a post box on that site and choose Insert.
          </p>
          <Button variant="plain" size="sm" class="mt-2" onClick={props.onDisarm}>
            Clear
          </Button>
        </div>
      )}
      {props.status !== undefined && (
        <div class="mt-3">
          <p role="status" class="text-sm">
            {props.status}
            {props.onUndo !== undefined && (
              <>
                {' '}
                <button type="button" class="link" disabled={props.busy} onClick={props.onUndo}>
                  Undo
                </button>
              </>
            )}
          </p>
          {props.statusDetails !== undefined && props.statusDetails.length > 0 && (
            <details class="mt-1 text-muted text-xs">
              <summary>Details</summary>
              {props.statusDetails.map((detail) => (
                <p key={detail} class="break-words">
                  {detail}
                </p>
              ))}
            </details>
          )}
        </div>
      )}
      {props.unrecorded > 0 && (
        <p class="mt-3 text-danger text-xs">
          {props.unrecorded === 1
            ? "1 inserted draft couldn't be marked done; it may show again on your other devices."
            : `${props.unrecorded} inserted drafts couldn't be marked done; they may show again on your other devices.`}{' '}
          <button type="button" class="link" onClick={props.onRetry}>
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
          onRetry={props.onSync}
        />
      )}
      {showTip && (
        <div class="sticky bottom-0 -mx-4 mt-4 flex items-start gap-2.5 border-line border-t bg-band py-2 pr-3 pl-4 text-ink-2 text-xs">
          <p class="flex-1">
            {shortcut === '' ? (
              "Tip: give qus.me a keyboard shortcut in your browser's extension shortcuts to pick drafts from any text field."
            ) : (
              <>
                Tip: in the post box, press <kbd class="kbd">{shortcut}</kbd> to pick a draft
                without opening this.
              </>
            )}
          </p>
          <button
            type="button"
            class="cursor-pointer px-0.5 text-base text-muted leading-none hover:text-ink"
            aria-label="Hide this tip"
            onClick={props.onDismissTip}
          >
            ×
          </button>
        </div>
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
  /** The toolbar's context chip for this tab, once detection ran (undefined: none). */
  onContext?: (chip: string | undefined) => void;
  /** How many accounts agents proposed are waiting, for the menu's count. */
  onPendingCount?: (count: number) => void;
}) {
  const { store, deps, setup } = props;
  const { onContext, onPendingCount } = props;
  const [tab, setTab] = useState<{ id: number; url: string } | undefined>();
  const [page, setPage] = useState<PageDrafts | undefined>();
  const [synced, setSynced] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [last, setLast] = useState<SyncSummary | undefined>();
  const [syncedAt, setSyncedAt] = useState<number | undefined>();
  const [destinations, setDestinations] = useState<Destination[]>([]);
  const [pending, setPending] = useState<PendingCard[]>([]);
  const [statusDetails, setStatusDetails] = useState<string[] | undefined>();
  const [tip, setTip] = useState(false);
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
    setSyncedAt(cache?.syncedAt);
    setLast(sync.last);
    setArmed(currentArmed);
    setUnrecorded(insertion.unrecorded.length);
    setTab(active);
    const drafts = cache?.drafts ?? [];
    const destinations = cache?.destinations ?? [];
    const source = deps?.definitions ?? definitionSource();
    setDestinations(destinations);
    const cards = setup === undefined ? [] : pendingCards(drafts, destinations, source);
    setPending(cards);
    onPendingCount?.(cards.length);
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
    onContext?.(deps === undefined ? undefined : pageChip(active?.url, detection?.found ?? {}));
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
        source,
        url,
        detected: detection?.found ?? {},
      })
    );
  }, [store, deps, setup, onContext, onPendingCount]);

  const liveRef = useRef(true);
  const sync = useCallback(() => {
    if (setup?.requestSync === undefined) return;
    setSyncing(true);
    setup
      .requestSync()
      .catch(() => undefined)
      .then(async () => {
        if (liveRef.current) await load();
      })
      .finally(() => liveRef.current && setSyncing(false));
  }, [setup, load]);
  useEffect(() => {
    liveRef.current = true;
    void load();
    // Opening the popup syncs (spec 11.4); the list shows the cache meanwhile.
    sync();
    const unsubscribe = deps?.onSessionChange?.(() => void load());
    return () => {
      liveRef.current = false;
      unsubscribe?.();
    };
  }, [load, deps, sync]);
  useEffect(() => {
    void pickerTipDismissed(store.local)
      .then((dismissed) => setTip(!dismissed))
      .catch(() => undefined);
  }, [store]);
  useEffect(() => {
    void deps
      ?.pickerShortcut?.()
      .then(setPickerShortcut)
      .catch(() => undefined);
  }, [deps]);

  const onArm = async (entry: PageDraft) => {
    setStatus(undefined);
    setStatusDetails(undefined);
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
    setStatusDetails(undefined);
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
        const detail = insertDetail(response);
        if (detail !== undefined) setStatusDetails([detail]);
        if (response.state === 'inserted' && response.recorded) setUndoable(entry.draft.d);
      }
    } catch (error) {
      setStatus('The insertion failed.');
      setStatusDetails([(error as Error)?.message ?? String(error)]);
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
      setStatus(`Added ${destinationLabel(deps.definitions, added.site, added.account, added)}.`);
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
    setStatusDetails(undefined);
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
      return 'Dismissed. It is in the Archive.';
    }, entry.draft.d);
  const onUndo = (d: string) =>
    void change(async () => {
      await restoreDraft(d, setup as SetupDeps);
      return 'Restored.';
    });
  const onRetry = async () => {
    if (deps === undefined) return;
    const result = await deps.retryRecord();
    setStatus(
      result.remaining === 0 ? 'Marked done.' : "Still couldn't mark every inserted draft done."
    );
    setStatusDetails(result.remaining === 0 ? undefined : result.messages);
    await load();
  };
  // An account an agent proposed, allowed or rejected from the card at the top (A7); the same
  // calls the Agents screen's PendingItem makes.
  const onAllow = (d: Destination) =>
    void change(async () => {
      await confirmPendingDestination(d.id, setup as SetupDeps);
      void setup?.requestSync?.().catch(() => undefined);
      return `Allowed ${destinationLabel(deps?.definitions ?? definitionSource(), d.site, d.account, d)}.`;
    });
  const onReject = (d: Destination) =>
    void change(async () => {
      const { dismissed } = await rejectPendingDestination(
        d.id,
        setup as SetupDeps,
        deps?.definitions
      );
      return `Rejected ${destinationLabel(deps?.definitions ?? definitionSource(), d.site, d.account, d)} and dismissed ${dismissed} draft${dismissed === 1 ? '' : 's'}.`;
    });
  const onDismissTip = () => {
    setTip(false);
    void dismissPickerTip(store.local).catch(() => undefined);
  };

  return (
    <InsertView
      url={deps === undefined ? undefined : tab?.url}
      page={page}
      definitions={deps?.definitions}
      destinations={destinations}
      syncedAt={syncedAt}
      synced={synced}
      syncing={syncing}
      last={last}
      statusDetails={statusDetails}
      pending={pending}
      tip={tip}
      onDismissTip={onDismissTip}
      onAllow={onAllow}
      onReject={onReject}
      onSync={setup?.requestSync === undefined ? undefined : sync}
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

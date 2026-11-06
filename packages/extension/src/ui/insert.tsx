/**
 * The popup's arming and inserting panel (spec 11.5 steps 1 to 5). On open it reads the active
 * tab (activeTab), runs the read-only account detection there, and lists the active drafts whose
 * destination matches the page, filtered by the detected account. Picking one arms it; Insert asks
 * the background to put it into the page's focused field. Draft selection happens here, in
 * extension origin: only the inserted draft's text ever reaches the page. Every draft string is a
 * JSX text child, which Preact sets as text.
 */
import type { SiteAccount } from '@qusme/nostr';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { addDestination } from '../agents/destinations.ts';
import { type ArmedDraft, arm, disarm, readArmed, readInsertionState } from '../insertion/armed.ts';
import type { SiteDefinitionSource } from '../insertion/definitions.ts';
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
import { readDraftCache } from '../sync/state.ts';
import { messageOf } from './app.tsx';
import { Button } from './components.tsx';
import { firstLine } from './drafts.tsx';

/** What the panel needs from the browser; absent in tests of the rest of the popup. */
export interface InsertionUiDeps {
  definitions: SiteDefinitionSource;
  /** The active tab, readable after the popup opened under activeTab. */
  activeTab(): Promise<{ id: number; url: string } | undefined>;
  detectAccounts(tabId: number, locators: readonly SiteAccount[]): Promise<(string | undefined)[]>;
  /** Asks the background to insert the armed draft into the tab. */
  insert(tabId: number): Promise<InsertResponse>;
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
  url: string | undefined;
  page: PageDrafts | undefined;
  /** Sites with an account locator where detection found nothing. */
  undetected: string[];
  armed: ArmedDraft | undefined;
  showElsewhere: boolean;
  status: string | undefined;
  unrecorded: number;
  busy: boolean;
  /** Detected accounts on registry sites with no destination yet (spec 7.2). */
  offers?: DestinationOffer[];
  /** The picker shortcut for the hint; empty when unbound, undefined when not known. */
  pickerShortcut?: string | undefined;
  onAddOffer?(offer: DestinationOffer): void;
  onArm(entry: PageDraft): void;
  onDisarm(): void;
  onInsert(): void;
  onRetry(): void;
  onToggleElsewhere(): void;
}

function DraftRow(props: {
  entry: PageDraft;
  armed: boolean;
  showAccount: boolean;
  onArm: (entry: PageDraft) => void;
}) {
  const { draft } = props.entry;
  return (
    <li class="flex items-start gap-2 rounded border border-ink/20 p-2">
      <div class="min-w-0 flex-1">
        <p class="text-ink/70 text-xs">
          {draft.site}
          {props.showAccount && ` / ${draft.account}`} · {draft.field}
        </p>
        <p class="break-words text-sm">{firstLine(draft.content)}</p>
      </div>
      <Button
        variant={props.armed ? 'primary' : 'plain'}
        class="px-2 py-1 text-xs"
        aria-pressed={props.armed}
        onClick={() => props.onArm(props.entry)}
      >
        {props.armed ? 'Armed' : 'Arm'}
      </Button>
    </li>
  );
}

/** The panel's markup, separate from its effects so it renders in tests. */
export function InsertView(props: ViewProps) {
  const { page, armed } = props;
  const detected = Object.entries(page?.detected ?? {});
  return (
    <section class="mt-4" aria-labelledby="insert-title">
      <h2 id="insert-title" class="font-semibold text-sm">
        On this page
      </h2>
      {props.pickerShortcut !== undefined && (
        <p class="mt-1 text-ink/70 text-xs">
          {props.pickerShortcut === ''
            ? "Give qus.me a keyboard shortcut in your browser's extension shortcuts to pick drafts from any text field."
            : `Press ${props.pickerShortcut} in any text field to pick a draft there.`}
        </p>
      )}
      {props.url === undefined ? (
        <p class="mt-1 text-ink/70 text-xs">This tab can't take drafts.</p>
      ) : (
        <>
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
          {page === undefined || page.matching.length === 0 ? (
            <p class="mt-2 text-sm">No drafts for this page.</p>
          ) : (
            <ul class="mt-2 flex flex-col gap-2">
              {page.matching.map((entry) => (
                <DraftRow
                  key={entry.draft.d}
                  entry={entry}
                  armed={armed?.d === entry.draft.d}
                  showAccount={page.detected[entry.draft.site] === undefined}
                  onArm={props.onArm}
                />
              ))}
            </ul>
          )}
          {page !== undefined && page.otherAccounts > 0 && (
            <p class="mt-1 text-ink/70 text-xs">
              {page.otherAccounts} draft{page.otherAccounts === 1 ? '' : 's'} for other accounts
              hidden.
            </p>
          )}
        </>
      )}
      {armed !== undefined && (
        <div class="mt-3 rounded border border-accent p-2">
          <p class="text-xs">Armed:</p>
          <p class="break-words text-sm">{firstLine(armed.content)}</p>
          <div class="mt-2 flex gap-2">
            {props.url !== undefined && (
              <Button class="px-2 py-1 text-sm" disabled={props.busy} onClick={props.onInsert}>
                Insert
              </Button>
            )}
            <Button variant="plain" class="px-2 py-1 text-sm" onClick={props.onDisarm}>
              Disarm
            </Button>
          </div>
          <p class="mt-1 text-ink/70 text-xs">
            Insert puts it into the field focused on the page. Right-clicking a field also offers
            it.
          </p>
        </div>
      )}
      {props.status !== undefined && (
        <p role="status" class="mt-2 text-sm">
          {props.status}
        </p>
      )}
      {props.unrecorded > 0 && (
        <p class="mt-2 text-danger text-xs">
          {props.unrecorded} insertion{props.unrecorded === 1 ? '' : 's'} not recorded on the relays
          yet.{' '}
          <button type="button" class="underline" onClick={props.onRetry}>
            Retry
          </button>
        </p>
      )}
      {page !== undefined && page.elsewhere.length > 0 && (
        <div class="mt-3">
          <button
            type="button"
            class="text-xs underline"
            aria-expanded={props.showElsewhere}
            onClick={props.onToggleElsewhere}
          >
            {props.showElsewhere ? 'Hide' : 'Show'} drafts for other sites ({page.elsewhere.length})
          </button>
          {props.showElsewhere && (
            <ul class="mt-2 flex flex-col gap-2">
              {page.elsewhere.map((entry) => (
                <DraftRow
                  key={entry.draft.d}
                  entry={entry}
                  armed={armed?.d === entry.draft.d}
                  showAccount={true}
                  onArm={props.onArm}
                />
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

/** The panel with its effects: tab, detection, arming and inserting. */
export function InsertPanel(props: {
  store: KeyStore;
  deps: InsertionUiDeps;
  /** For the add-destination shortcut; without it the panel offers none. */
  setup?: SetupDeps;
}) {
  const { store, deps, setup } = props;
  const [tab, setTab] = useState<{ id: number; url: string } | undefined>();
  const [page, setPage] = useState<PageDrafts | undefined>();
  const [undetected, setUndetected] = useState<string[]>([]);
  const [armed, setArmed] = useState<ArmedDraft | undefined>();
  const [showElsewhere, setShowElsewhere] = useState(false);
  const [status, setStatus] = useState<string>();
  const [unrecorded, setUnrecorded] = useState(0);
  const [busy, setBusy] = useState(false);
  const [offers, setOffers] = useState<DestinationOffer[]>([]);
  const [pickerShortcut, setPickerShortcut] = useState<string | undefined>();
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
    tabRef.current ??= deps.activeTab().catch(() => undefined);
    const [cache, currentArmed, insertion, active] = await Promise.all([
      readDraftCache(store.session),
      readArmed(store.session),
      readInsertionState(store.session),
      tabRef.current,
    ]);
    setArmed(currentArmed);
    setUnrecorded(insertion.unrecorded.length);
    setTab(active);
    const drafts = cache?.drafts ?? [];
    const destinations = cache?.destinations ?? [];
    const url = active?.url ?? '';
    if (active !== undefined && cache !== undefined) {
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
        source: deps.definitions,
        url,
        detected: detection?.found ?? {},
      })
    );
  }, [store, deps]);

  useEffect(() => {
    void load();
    return deps.onSessionChange?.(() => void load());
  }, [load, deps]);
  useEffect(() => {
    void deps
      .pickerShortcut?.()
      .then(setPickerShortcut)
      .catch(() => undefined);
  }, [deps]);

  const onArm = async (entry: PageDraft) => {
    setStatus(undefined);
    setArmed(await arm(store.session, entry.draft, Math.floor(Date.now() / 1000)));
  };
  const onDisarm = async () => {
    await disarm(store.session);
    setArmed(undefined);
  };
  const onInsert = async () => {
    if (tab === undefined || armed === undefined) return;
    setBusy(true);
    const content = armed.content;
    try {
      const response = await deps.insert(tab.id);
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
      }
    } catch (error) {
      setStatus(`The insertion failed: ${(error as Error)?.message ?? String(error)}`);
    } finally {
      setBusy(false);
      await load();
    }
  };
  const onAddOffer = async (offer: DestinationOffer) => {
    if (setup === undefined) return;
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
  const onRetry = async () => {
    const result = await deps.retryRecord();
    setStatus(result.remaining === 0 ? 'Recorded.' : (result.messages[0] ?? 'Still not recorded.'));
    await load();
  };

  return (
    <InsertView
      url={tab?.url}
      page={page}
      undetected={undetected}
      armed={armed}
      showElsewhere={showElsewhere}
      status={status}
      unrecorded={unrecorded}
      busy={busy}
      offers={offers}
      pickerShortcut={pickerShortcut}
      onAddOffer={(o) => void onAddOffer(o)}
      onArm={(e) => void onArm(e)}
      onDisarm={() => void onDisarm()}
      onInsert={() => void onInsert()}
      onRetry={() => void onRetry()}
      onToggleElsewhere={() => setShowElsewhere(!showElsewhere)}
    />
  );
}

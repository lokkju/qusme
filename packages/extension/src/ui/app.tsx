import { npubEncode } from 'nostr-tools/nip19';
import type { ComponentChildren } from 'preact';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { definitionSource } from '../insertion/definitions.ts';
import { type KeyStatus, type PendingImport, WrongPassphrase } from '../keyStore.ts';
import { type SetupDeps, SetupError } from '../setup/deps.ts';
import { readDraftCache } from '../sync/state.ts';
import { AgentsScreen, ApproveAgentScreen } from './agents.tsx';
import { ArchiveScreen } from './archive.tsx';
import { Button, ErrorText, Field, inputClass, Screen } from './components.tsx';
import { CreateScreen } from './create.tsx';
import { DestinationsScreen } from './destinations.tsx';
import { FirstRunChecklist } from './firstRun.tsx';
import { type InsertionUiDeps, InsertPanel } from './insert.tsx';
import { type MenuTarget, OverflowMenu, Toolbar } from './menu.tsx';
import { PairScreen, PairSourceScreen } from './pair.tsx';
import { RecoverScreen } from './recover.tsx';
import { RecoveryLookupCard } from './recoveryLookup.tsx';
import { RelaySwapScreen } from './relays.tsx';

export type Route =
  | 'home'
  | 'create'
  | 'pair'
  | 'recover'
  | 'pair-source'
  | 'approve-agent'
  | 'agents'
  | 'destinations'
  | 'add-destination'
  | 'archive'
  | 'relay-swap'
  | 'settings';

/** A message for the user from anything a flow threw. */
export function messageOf(error: unknown): string {
  if (error instanceof SetupError || error instanceof WrongPassphrase) return error.message;
  return `Something went wrong: ${(error as Error)?.message ?? String(error)}`;
}

export function App(props: {
  deps: SetupDeps;
  openInTab?: () => void;
  approveCode?: string;
  /**
   * Reads the approval code off the active tab when it is a qus.me sign-in page (critique A1);
   * the popup then opens on the approval with the code filled in.
   */
  tabApprovalCode?: () => Promise<string | undefined>;
  insertion?: InsertionUiDeps;
}) {
  const { deps } = props;
  const [status, setStatus] = useState<KeyStatus | undefined>();
  const [pending, setPending] = useState<PendingImport | undefined>();
  // A popup opened with an approval code goes to the approval screen once unlocked (spec 11.8).
  const [route, setRoute] = useState<Route>(props.approveCode ? 'approve-agent' : 'home');
  // The storage relay the swap screen replaces (spec 9.1) and the queue's relays when it opened.
  const [swap, setSwap] = useState<{ dead: string; current: string[] } | undefined>();
  // The toolbar's chip (the home list reports it after detection) and the menu's Agents count.
  const [chip, setChip] = useState<string | undefined>();
  const [waiting, setWaiting] = useState(0);
  // The code on the sign-in page this popup opened over, if it opened over one.
  const [tabCode, setTabCode] = useState<string | undefined>();

  const refresh = useCallback(async () => {
    const next = await deps.store.status();
    setStatus(next);
    setPending(await deps.store.pendingImport());
    const cache = next.state === 'unlocked' ? await readDraftCache(deps.store.session) : undefined;
    setWaiting((cache?.destinations ?? []).filter((d) => d.status === 'pending').length);
  }, [deps]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Once, on open: a popup opened over a sign-in page goes to the approval with its code, unless
  // it was opened with one already or the user has gone somewhere else meanwhile.
  useEffect(() => {
    if (props.approveCode !== undefined || props.tabApprovalCode === undefined) return;
    void props
      .tabApprovalCode()
      .then((code) => {
        if (code === undefined) return;
        setTabCode(code);
        setRoute((current) => (current === 'home' ? 'approve-agent' : current));
      })
      .catch(() => undefined);
  }, []);

  const home = () => {
    setRoute('home');
    void refresh();
  };

  const approveCode = props.approveCode ?? tabCode;
  let body: ComponentChildren;
  if (status === undefined) {
    body = <p>Loading…</p>;
  } else if (route === 'create') {
    body = (
      <CreateScreen
        deps={deps}
        onDone={home}
        onBack={home}
        onAddAccount={() => setRoute('add-destination')}
        onPair={() => setRoute('pair-source')}
      />
    );
  } else if (route === 'pair' || (status.state === 'empty' && pending !== undefined)) {
    body = <PairScreen deps={deps} pending={pending} onDone={home} onBack={home} />;
  } else if (route === 'recover') {
    body = (
      <RecoverScreen deps={deps} forgot={status.state === 'locked'} onDone={home} onBack={home} />
    );
  } else if (route === 'pair-source' && status.state === 'unlocked') {
    body = <PairSourceScreen deps={deps} onDone={home} />;
  } else if (route === 'approve-agent' && status.state === 'unlocked') {
    body = (
      <ApproveAgentScreen
        deps={deps}
        {...(approveCode !== undefined && { initialCode: approveCode })}
        fromTab={props.approveCode === undefined && tabCode !== undefined}
        source={props.insertion?.definitions ?? definitionSource()}
        onDone={home}
        onBack={home}
      />
    );
  } else if (route === 'agents' && status.state === 'unlocked') {
    body = (
      <AgentsScreen
        deps={deps}
        source={props.insertion?.definitions ?? definitionSource()}
        onBack={home}
        onApprove={() => setRoute('approve-agent')}
      />
    );
  } else if (route === 'relay-swap' && status.state === 'unlocked' && swap !== undefined) {
    body = <RelaySwapScreen deps={deps} dead={swap.dead} current={swap.current} onBack={home} />;
  } else if (route === 'archive' && status.state === 'unlocked') {
    body = <ArchiveScreen deps={deps} onBack={home} />;
  } else if (route === 'settings' && status.state === 'unlocked') {
    body = (
      <SettingsScreen
        deps={deps}
        status={status}
        insertion={props.insertion}
        onBack={home}
        onChange={refresh}
      />
    );
  } else if (
    (route === 'destinations' || route === 'add-destination') &&
    status.state === 'unlocked'
  ) {
    body = (
      <DestinationsScreen
        deps={deps}
        definitions={props.insertion?.definitions ?? definitionSource()}
        detect={props.insertion}
        onBack={home}
        startAdding={route === 'add-destination' ? 'x' : undefined}
      />
    );
  } else if (status.state === 'empty') {
    body = <Welcome onRoute={setRoute} />;
  } else if (status.state === 'locked') {
    body = (
      <Unlock
        deps={deps}
        onUnlocked={() => {
          // An approval the popup opened for waits behind Unlock; everything else goes home.
          if (route !== 'approve-agent') setRoute('home');
          void refresh();
        }}
        onForgot={() => setRoute('recover')}
      />
    );
  } else {
    body = (
      <Unlocked
        deps={deps}
        onRoute={setRoute}
        insertion={props.insertion}
        onContext={setChip}
        onPendingCount={setWaiting}
        onReplaceRelay={async (dead) => {
          const record = await deps.store.record();
          setSwap({ dead, current: record?.storageRelays ?? [] });
          setRoute('relay-swap');
        }}
      />
    );
  }

  const unlocked = status?.state === 'unlocked';
  const showHome = unlocked && route === 'home';
  return (
    <div class="flex max-h-[600px] min-w-[22rem] max-w-md flex-col bg-paper text-ink">
      <Toolbar chip={showHome ? chip : undefined}>
        {unlocked && (
          <OverflowMenu
            pending={waiting}
            onSelect={(target: MenuTarget) => setRoute(target)}
            onLock={async () => {
              await deps.store.lock();
              setChip(undefined);
              home();
            }}
          />
        )}
      </Toolbar>
      {/*
       * The home list ends with its own padding or the tip, which sticks to the bottom edge; so
       * does a screen with a pinned bottom bar (components.tsx BottomBar).
       */}
      <div
        class={`min-h-0 flex-1 overflow-y-auto px-4 pt-3 ${showHome ? '' : 'pb-4 has-[[data-bottom-bar]]:pb-0'}`}
      >
        {body}
        {/* Only pairing involves the other device, and the popup closes when the user turns to it (F4). */}
        {props.openInTab &&
          (route === 'pair' ||
            route === 'pair-source' ||
            (status?.state === 'empty' && pending !== undefined)) && (
            <p class="mt-4 text-muted text-xs">
              <button type="button" class="link" onClick={props.openInTab}>
                Open in a tab
              </button>{' '}
              so this stays open while you use your other device.
            </p>
          )}
      </div>
    </div>
  );
}

function Welcome(props: { onRoute: (route: Route) => void }) {
  return (
    <Screen title="Set up qus.me">
      <p class="mt-2 text-sm">
        Drafts from you and your agents, inserted into the post box on x.com, Bluesky, Mastodon or
        LinkedIn. You still press Post.
      </p>
      <div class="mt-4 flex flex-col gap-2">
        <Button onClick={() => props.onRoute('create')}>Create a new queue</Button>
        <Button variant="plain" onClick={() => props.onRoute('pair')}>
          Pair with a device that has the queue
        </Button>
        <Button variant="plain" onClick={() => props.onRoute('recover')}>
          Recover with the recovery code
        </Button>
      </div>
      <p class="mt-3 text-muted text-xs">Encrypted end to end; only your devices can read it.</p>
    </Screen>
  );
}

/** Resolves after the browser has painted, so a busy state shows before a blocking step. */
function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => setTimeout(resolve, 0));
    } else {
      setTimeout(resolve, 0);
    }
  });
}

/**
 * Unlock (critique U1): the passphrase focused on open, a progress line while scrypt runs (it
 * blocks the page for a second or more, so the line is painted first), and a way to recovery by
 * code for a forgotten passphrase.
 */
export function Unlock(props: { deps: SetupDeps; onUnlocked: () => void; onForgot?: () => void }) {
  const [passphrase, setPassphrase] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    field.current?.focus();
  }, []);
  const submit = async (event: Event) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    let unlocked = false;
    try {
      await nextPaint();
      await props.deps.store.unlock(passphrase);
      setPassphrase('');
      unlocked = true;
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
    if (unlocked) props.onUnlocked();
    else field.current?.focus();
  };
  return (
    <Screen title="Unlock">
      <form onSubmit={submit}>
        <Field id="unlock-passphrase" label="Passphrase">
          <input
            id="unlock-passphrase"
            ref={field}
            type="password"
            autocomplete="current-password"
            class={inputClass}
            value={passphrase}
            disabled={busy}
            onInput={(e) => setPassphrase(e.currentTarget.value)}
          />
        </Field>
        <ErrorText message={error} />
        <Button type="submit" class="mt-3" disabled={busy || passphrase === ''}>
          {busy ? 'Unlocking…' : 'Unlock'}
        </Button>
        <div role="status" class="mt-3" data-unlock-progress>
          {busy && (
            <>
              <div class="h-1 overflow-hidden rounded-full bg-line" aria-hidden="true">
                <div class="progress-indeterminate h-full w-1/3 rounded-full bg-accent" />
              </div>
              <p class="mt-1.5 text-muted text-xs">Opening your queue, a few seconds…</p>
            </>
          )}
        </div>
      </form>
      {props.onForgot !== undefined && (
        <p class="mt-2 text-xs">
          <button type="button" class="link" onClick={props.onForgot}>
            Forgot your passphrase? Recover with your code
          </button>
        </p>
      )}
    </Screen>
  );
}

function Unlocked(props: {
  deps: SetupDeps;
  onRoute: (route: Route) => void;
  insertion?: InsertionUiDeps | undefined;
  onReplaceRelay?: (url: string) => void;
  onContext?: (chip: string | undefined) => void;
  onPendingCount?: (count: number) => void;
}) {
  const { deps } = props;
  // The checklist is the list's empty state while it shows (critique F6, B's first run).
  const [checklistShown, setChecklistShown] = useState(false);
  return (
    <section class="flex flex-col" aria-labelledby="screen-title">
      <RecoveryLookupCard deps={deps} />
      <InsertPanel
        store={deps.store}
        onboarding={
          <FirstRunChecklist
            deps={deps}
            onAddDestination={() => props.onRoute('add-destination')}
            onPair={() => props.onRoute('pair-source')}
            onShown={setChecklistShown}
          />
        }
        onboardingShown={checklistShown}
        deps={props.insertion}
        setup={deps}
        onPair={() => props.onRoute('pair')}
        onAgents={() => props.onRoute('agents')}
        {...(props.onReplaceRelay !== undefined && { onReplaceRelay: props.onReplaceRelay })}
        {...(props.onContext !== undefined && { onContext: props.onContext })}
        {...(props.onPendingCount !== undefined && { onPendingCount: props.onPendingCount })}
      />
    </section>
  );
}

/** Settings and about: staying unlocked, the picker shortcut and the queue's ID (critique H2). */
function SettingsScreen(props: {
  deps: SetupDeps;
  status: Extract<KeyStatus, { state: 'unlocked' }>;
  insertion?: InsertionUiDeps | undefined;
  onBack: () => void;
  onChange: () => void;
}) {
  const { deps, status } = props;
  const [shortcut, setShortcut] = useState<string | undefined>();
  useEffect(() => {
    void props.insertion
      ?.pickerShortcut?.()
      .then(setShortcut)
      .catch(() => undefined);
  }, [props.insertion]);
  const toggle = async (on: boolean) => {
    await deps.store.setStayUnlocked(on);
    props.onChange();
  };
  return (
    <Screen title="Settings" onBack={props.onBack}>
      <div class="mt-4 flex items-start gap-2">
        <input
          id="stay-unlocked"
          type="checkbox"
          class="mt-1"
          checked={status.stayUnlocked}
          aria-describedby="stay-unlocked-warning"
          onChange={(e) => void toggle(e.currentTarget.checked)}
        />
        <div>
          <label for="stay-unlocked" class="font-medium text-sm">
            Stay unlocked on this device
          </label>
          <p id="stay-unlocked-warning" class="text-muted text-xs">
            Keeps the queue key unencrypted on this computer so a browser restart doesn't ask for
            the passphrase. Anyone with access to this browser profile can then read and change the
            queue.
          </p>
        </div>
      </div>
      {shortcut !== undefined && (
        <div class="mt-4">
          <p class="font-medium text-sm">Picker shortcut</p>
          <p class="mt-1 text-muted text-xs">
            {shortcut === ''
              ? "None. Give qus.me a keyboard shortcut in your browser's extension shortcuts to pick drafts from any text field."
              : `Press ${shortcut} in a post box to pick a draft there. Change it in your browser's extension shortcuts.`}
          </p>
        </div>
      )}
      <QueueAbout pubkey={status.pubkey} />
    </Screen>
  );
}

/**
 * The queue's ID, for recovery and support; the recovery sheet has it too (spec 6.1). Rendered
 * only on Settings, behind a button, so the home screen carries no npub.
 */
function QueueAbout(props: { pubkey: string }) {
  const [shown, setShown] = useState(false);
  return (
    <div class="mt-4">
      <p class="font-medium text-sm">About this queue</p>
      {shown ? (
        <p class="mt-1 text-xs">
          Queue ID: <span class="break-all font-mono">{npubEncode(props.pubkey)}</span>
        </p>
      ) : (
        <button type="button" class="mt-1 text-xs link" onClick={() => setShown(true)}>
          Show Queue ID
        </button>
      )}
    </div>
  );
}

import { npubEncode } from 'nostr-tools/nip19';
import type { ComponentChildren } from 'preact';
import { useCallback, useEffect, useState } from 'preact/hooks';
import { type KeyStatus, type PendingImport, WrongPassphrase } from '../keyStore.ts';
import { type SetupDeps, SetupError } from '../setup/deps.ts';
import { AgentsScreen, ApproveAgentScreen } from './agents.tsx';
import { Button, ErrorText, Field, inputClass, Screen } from './components.tsx';
import { CreateScreen } from './create.tsx';
import { Drafts } from './drafts.tsx';
import { type InsertionUiDeps, InsertPanel } from './insert.tsx';
import { PairScreen, PairSourceScreen } from './pair.tsx';
import { RecoverScreen } from './recover.tsx';

export type Route =
  | 'home'
  | 'create'
  | 'pair'
  | 'recover'
  | 'pair-source'
  | 'approve-agent'
  | 'agents';

/** A message for the user from anything a flow threw. */
export function messageOf(error: unknown): string {
  if (error instanceof SetupError || error instanceof WrongPassphrase) return error.message;
  return `Something went wrong: ${(error as Error)?.message ?? String(error)}`;
}

export function App(props: {
  deps: SetupDeps;
  openInTab?: () => void;
  approveCode?: string;
  insertion?: InsertionUiDeps;
}) {
  const { deps } = props;
  const [status, setStatus] = useState<KeyStatus | undefined>();
  const [pending, setPending] = useState<PendingImport | undefined>();
  // A popup opened with an approval code goes to the approval screen once unlocked (spec 11.8).
  const [route, setRoute] = useState<Route>(props.approveCode ? 'approve-agent' : 'home');

  const refresh = useCallback(async () => {
    setStatus(await deps.store.status());
    setPending(await deps.store.pendingImport());
  }, [deps]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const home = () => {
    setRoute('home');
    void refresh();
  };

  let body: ComponentChildren;
  if (status === undefined) {
    body = <p>Loading…</p>;
  } else if (route === 'create') {
    body = <CreateScreen deps={deps} onDone={home} onBack={home} />;
  } else if (route === 'pair' || (status.state === 'empty' && pending !== undefined)) {
    body = <PairScreen deps={deps} pending={pending} onDone={home} onBack={home} />;
  } else if (route === 'recover') {
    body = <RecoverScreen deps={deps} onDone={home} onBack={home} />;
  } else if (route === 'pair-source' && status.state === 'unlocked') {
    body = <PairSourceScreen deps={deps} onDone={home} />;
  } else if (route === 'approve-agent' && status.state === 'unlocked') {
    body = (
      <ApproveAgentScreen
        deps={deps}
        {...(props.approveCode !== undefined && { initialCode: props.approveCode })}
        onDone={home}
        onBack={home}
      />
    );
  } else if (route === 'agents' && status.state === 'unlocked') {
    body = <AgentsScreen deps={deps} onBack={home} />;
  } else if (status.state === 'empty') {
    body = <Welcome onRoute={setRoute} />;
  } else if (status.state === 'locked') {
    body = <Unlock deps={deps} onUnlocked={home} />;
  } else {
    body = (
      <Unlocked
        deps={deps}
        status={status}
        onRoute={setRoute}
        onChange={refresh}
        insertion={props.insertion}
      />
    );
  }

  return (
    <div class="min-w-[22rem] max-w-md bg-paper p-4 text-ink">
      {body}
      {props.openInTab && route !== 'home' && route !== 'approve-agent' && route !== 'agents' && (
        <p class="mt-4 text-xs">
          <button type="button" class="underline" onClick={props.openInTab}>
            Open in a tab
          </button>{' '}
          so this stays open while you use your other device.
        </p>
      )}
    </div>
  );
}

function Welcome(props: { onRoute: (route: Route) => void }) {
  return (
    <Screen title="Set up qus.me">
      <p class="mt-2 text-sm">
        Your drafts queue lives encrypted on Nostr relays. This device needs the queue key.
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
    </Screen>
  );
}

function Unlock(props: { deps: SetupDeps; onUnlocked: () => void }) {
  const [passphrase, setPassphrase] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const submit = async (event: Event) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await props.deps.store.unlock(passphrase);
      setPassphrase('');
      props.onUnlocked();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Screen title="Unlock">
      <form onSubmit={submit}>
        <Field id="unlock-passphrase" label="Passphrase">
          <input
            id="unlock-passphrase"
            type="password"
            autocomplete="current-password"
            class={inputClass}
            value={passphrase}
            onInput={(e) => setPassphrase(e.currentTarget.value)}
          />
        </Field>
        <ErrorText message={error} />
        <Button type="submit" class="mt-3" disabled={busy || passphrase === ''}>
          {busy ? 'Unlocking…' : 'Unlock'}
        </Button>
      </form>
    </Screen>
  );
}

function Unlocked(props: {
  deps: SetupDeps;
  status: Extract<KeyStatus, { state: 'unlocked' }>;
  onRoute: (route: Route) => void;
  onChange: () => void;
  insertion?: InsertionUiDeps | undefined;
}) {
  const { deps, status } = props;
  const toggle = async (on: boolean) => {
    await deps.store.setStayUnlocked(on);
    props.onChange();
  };
  return (
    <Screen title="qus.me">
      <p class="mt-2 break-all font-mono text-xs">{npubEncode(status.pubkey)}</p>
      {props.insertion && <InsertPanel store={deps.store} deps={props.insertion} />}
      <Drafts deps={deps} />
      <div class="mt-4 flex flex-col gap-2">
        <Button onClick={() => props.onRoute('approve-agent')}>Approve an agent</Button>
        <Button variant="plain" onClick={() => props.onRoute('agents')}>
          Agents and pending destinations
        </Button>
        <Button variant="plain" onClick={() => props.onRoute('pair-source')}>
          Pair a new device
        </Button>
        <Button
          variant="plain"
          onClick={async () => {
            await deps.store.lock();
            props.onChange();
          }}
        >
          Lock
        </Button>
      </div>
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
          <p id="stay-unlocked-warning" class="text-ink/70 text-xs">
            Keeps the queue key unencrypted on this computer so a browser restart doesn't ask for
            the passphrase. Anyone with access to this browser profile can then read and change the
            queue.
          </p>
        </div>
      </div>
    </Screen>
  );
}

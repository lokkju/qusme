import { formatPairingCode } from '@qusme/nostr';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { PendingImport } from '../keyStore.ts';
import { checkPassphrase } from '../passphrase.ts';
import type { SetupDeps } from '../setup/deps.ts';
import { SourcePairing, type SourcePhase } from '../setup/pairSource.ts';
import {
  finishPairing,
  openPendingImport,
  resolvePairingInput,
  TargetPairing,
  type TargetPhase,
} from '../setup/pairTarget.ts';
import { messageOf } from './app.tsx';
import {
  Button,
  ErrorText,
  Field,
  inputClass,
  LossWarning,
  NewPassphrase,
  Qr,
  Sas,
  Screen,
} from './components.tsx';

/** The new device's side of pairing (spec 8.3). */
export function PairScreen(props: {
  deps: SetupDeps;
  pending: PendingImport | undefined;
  onDone: () => void;
  onBack: () => void;
}) {
  const { deps } = props;
  const [input, setInput] = useState('');
  const [phase, setPhase] = useState<TargetPhase | undefined>();
  const [pending, setPending] = useState<PendingImport | undefined>(props.pending);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const pairing = useRef<TargetPairing | undefined>(undefined);

  useEffect(() => () => pairing.current?.close(), []);
  useEffect(() => {
    if (phase?.phase === 'unlock') void deps.store.pendingImport().then(setPending);
  }, [phase, deps]);

  if (pending !== undefined) {
    return (
      <PairUnlock
        deps={deps}
        pending={pending}
        onDone={props.onDone}
        onCancel={async () => {
          await deps.store.clearPendingImport();
          props.onBack();
        }}
      />
    );
  }

  if (phase === undefined) {
    // Called straight from the submit handler: a typed code asks for the service permission
    // before anything else is awaited (Firefox requires the user's gesture).
    const submit = async (event: Event) => {
      event.preventDefault();
      setBusy(true);
      setError(undefined);
      try {
        const resolved = await resolvePairingInput(input, deps);
        pairing.current = await TargetPairing.start(resolved, deps, setPhase);
      } catch (e) {
        setError(messageOf(e));
      } finally {
        setBusy(false);
      }
    };
    return (
      <Screen title="Pair with your other device" onBack={props.onBack}>
        <p class="mt-2 text-sm">
          On a device that has the queue, choose “Pair a new device”. Copy the pairing link it
          shows, or ask it for a typed code.
        </p>
        <form onSubmit={submit}>
          <Field
            id="pair-input"
            label="Pairing link or code"
            hint="A nostrpair:// link, or 8 letters and digits."
          >
            <textarea
              id="pair-input"
              rows={3}
              class={inputClass}
              spellcheck={false}
              autocomplete="off"
              value={input}
              aria-describedby="pair-input-hint"
              onInput={(e) => setInput(e.currentTarget.value)}
            />
          </Field>
          <ErrorText message={error} />
          <Button type="submit" class="mt-3" disabled={busy || input.trim() === ''}>
            {busy ? 'Connecting…' : 'Continue'}
          </Button>
        </form>
      </Screen>
    );
  }

  if (phase.phase === 'failed') {
    return (
      <Screen title="Pairing stopped">
        <ErrorText message={phase.message} />
        <Button class="mt-3" onClick={props.onBack}>
          Back
        </Button>
      </Screen>
    );
  }

  if (phase.phase === 'compare') {
    const act = async (confirm: boolean) => {
      setBusy(true);
      try {
        await (confirm ? pairing.current?.confirmSas() : pairing.current?.deny());
      } catch (e) {
        setError(messageOf(e));
      } finally {
        setBusy(false);
      }
    };
    return (
      <Screen title="Compare the codes">
        <p class="mt-2 text-sm">Does your other device show the same code?</p>
        <Sas code={phase.sas} />
        {phase.confirmed ? (
          <p class="text-sm" aria-live="polite">
            Waiting for your other device…
          </p>
        ) : (
          <div class="flex gap-2">
            <Button disabled={busy} onClick={() => act(true)}>
              Yes, they match
            </Button>
            <Button variant="danger" disabled={busy} onClick={() => act(false)}>
              No
            </Button>
          </div>
        )}
        <ErrorText message={error} />
      </Screen>
    );
  }

  return <p aria-live="polite">Receiving the key…</p>;
}

/**
 * After the payload is stored: the passphrase (QR) or recovery code (typed code) opens it, then a
 * new local passphrase, then the relay check of spec 8.3 step 7.
 */
function PairUnlock(props: {
  deps: SetupDeps;
  pending: PendingImport;
  onDone: () => void;
  onCancel: () => void;
}) {
  const { deps, pending } = props;
  const recovery = pending.unlockWith === 'recovery-code';
  const [secret, setSecret] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [again, setAgain] = useState('');
  const [relayPrompt, setRelayPrompt] = useState<string>();
  const [relayUrl, setRelayUrl] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ settingsFound: boolean }>();

  const strength = checkPassphrase(passphrase);
  const problem = !strength.ok
    ? strength.problem
    : again !== '' && again !== passphrase
      ? 'The two entries differ.'
      : undefined;

  const submit = async (event: Event) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const key = openPendingImport(pending, secret);
      const result = await finishPairing(
        pending,
        key,
        passphrase,
        deps,
        relayPrompt === undefined ? undefined : relayUrl
      );
      if (result.ok) {
        setDone({ settingsFound: result.settingsFound });
      } else {
        key.fill(0);
        setRelayPrompt(result.message);
      }
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };

  if (done !== undefined) {
    return (
      <Screen title="Paired">
        <p class="mt-2 text-sm">This device now holds the queue key and is unlocked.</p>
        {!done.settingsFound && (
          <p class="mt-2 text-sm">
            The queue’s settings were not found, so agent drafts can’t be read here yet.
          </p>
        )}
        <Button class="mt-3" onClick={props.onDone}>
          Done
        </Button>
      </Screen>
    );
  }

  return (
    <Screen title="Unlock the received key">
      <form onSubmit={submit}>
        <Field
          id="pair-secret"
          label={recovery ? 'Recovery code' : 'Passphrase of your other device'}
          hint={
            recovery
              ? 'This pairing used a typed code, so it sent the backup that the recovery code opens.'
              : 'The key arrived encrypted under the passphrase you use on the other device.'
          }
        >
          {recovery ? (
            <textarea
              id="pair-secret"
              rows={3}
              class={inputClass}
              spellcheck={false}
              autocomplete="off"
              value={secret}
              aria-describedby="pair-secret-hint"
              onInput={(e) => setSecret(e.currentTarget.value)}
            />
          ) : (
            <input
              id="pair-secret"
              type="password"
              autocomplete="current-password"
              class={inputClass}
              value={secret}
              aria-describedby="pair-secret-hint"
              onInput={(e) => setSecret(e.currentTarget.value)}
            />
          )}
        </Field>
        <NewPassphrase
          value={passphrase}
          confirm={again}
          problem={problem}
          onInput={setPassphrase}
          onConfirm={setAgain}
        />
        <LossWarning />
        {relayPrompt !== undefined && (
          <Field id="pair-relay" label="A storage relay of the queue" hint={relayPrompt}>
            <input
              id="pair-relay"
              class={inputClass}
              spellcheck={false}
              value={relayUrl}
              aria-describedby="pair-relay-hint"
              onInput={(e) => setRelayUrl(e.currentTarget.value)}
            />
          </Field>
        )}
        <ErrorText message={error} />
        <div class="mt-3 flex gap-2">
          <Button
            type="submit"
            disabled={
              busy ||
              secret === '' ||
              !strength.ok ||
              again !== passphrase ||
              (relayPrompt !== undefined && relayUrl.trim() === '')
            }
          >
            {busy ? 'Unlocking…' : 'Finish'}
          </Button>
          <Button variant="plain" onClick={props.onCancel}>
            Discard
          </Button>
        </div>
      </form>
    </Screen>
  );
}

/** The existing device's side of pairing (spec 8.3). */
export function PairSourceScreen(props: { deps: SetupDeps; onDone: () => void }) {
  const { deps } = props;
  const [phase, setPhase] = useState<SourcePhase>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [started, setStarted] = useState<SourcePairing>();
  const pairing = useRef<SourcePairing | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    SourcePairing.start(deps, (p) => {
      if (!cancelled) setPhase(p);
    }).then(
      (started) => {
        if (cancelled) {
          started.close();
        } else {
          pairing.current = started;
          setStarted(started);
        }
      },
      (e: unknown) => setError(messageOf(e))
    );
    return () => {
      cancelled = true;
      pairing.current?.close();
    };
  }, [deps]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    try {
      await fn();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };

  const finish = (
    <Button class="mt-3" onClick={props.onDone}>
      Done
    </Button>
  );

  if (phase === undefined) {
    return (
      <Screen title="Pair a new device" onBack={props.onDone}>
        {error === undefined ? <p class="mt-2">Connecting…</p> : <ErrorText message={error} />}
      </Screen>
    );
  }
  switch (phase.phase) {
    case 'waiting':
      return (
        <Screen title="Pair a new device" onBack={props.onDone}>
          <p class="mt-2 text-sm">
            On the new device, choose “Pair with a device that has the queue”, then scan this code
            or paste the link.
          </p>
          <Qr text={phase.uri} label="Pairing QR code" />
          <Button
            variant="plain"
            class="w-full text-sm"
            onClick={() =>
              act(async () => {
                await navigator.clipboard.writeText(phase.uri);
                setCopied(true);
              })
            }
          >
            {copied ? 'Link copied' : 'Copy pairing link'}
          </Button>
          {phase.code !== undefined ? (
            <div class="mt-3 text-center">
              <p class="text-sm">Or type this code on the new device:</p>
              <p class="font-mono font-semibold text-2xl tracking-widest">
                {formatPairingCode(phase.code)}
              </p>
              <p class="text-ink/70 text-xs">
                It will then ask for your recovery code instead of your passphrase.
              </p>
            </div>
          ) : (
            started?.canIssueCode && (
              <Button
                variant="plain"
                class="mt-2 w-full text-sm"
                disabled={busy}
                onClick={() => act(() => started.requestCode())}
              >
                The new device has no camera: use a typed code
              </Button>
            )
          )}
          <ErrorText message={error} />
        </Screen>
      );
    case 'compare':
      return (
        <Screen title="Compare the codes">
          <p class="mt-2 text-sm">Does the new device show the same code?</p>
          <Sas code={phase.sas} />
          <div class="flex gap-2">
            <Button
              disabled={busy}
              onClick={() => act(() => (started as SourcePairing).confirmSas())}
            >
              Yes, they match
            </Button>
            <Button
              variant="danger"
              disabled={busy}
              onClick={() => act(() => (started as SourcePairing).deny())}
            >
              No
            </Button>
          </div>
          <ErrorText message={error} />
        </Screen>
      );
    case 'sent':
      return (
        <Screen title="Sending">
          <p class="mt-2 text-sm" aria-live="polite">
            Sent. Waiting for the new device to confirm…
          </p>
        </Screen>
      );
    case 'done':
      return (
        <Screen title="Paired">
          <p class="mt-2 text-sm">The new device received the key.</p>
          {finish}
        </Screen>
      );
    case 'unconfirmed':
      return (
        <Screen title="Transfer sent">
          <p class="mt-2 text-sm">The key was sent; check your other device.</p>
          {finish}
        </Screen>
      );
    default:
      return (
        <Screen title="Pairing stopped">
          <ErrorText message={phase.message} />
          {finish}
        </Screen>
      );
  }
}

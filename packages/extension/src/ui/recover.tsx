import { useState } from 'preact/hooks';
import { checkPassphrase } from '../passphrase.ts';
import type { SetupDeps } from '../setup/deps.ts';
import {
  type FetchedBackup,
  fetchRecoveryBackup,
  finishRecover,
  openRecoveryBackup,
  type RecoverResult,
} from '../setup/recover.ts';
import { messageOf } from './app.tsx';
import {
  Button,
  ErrorText,
  Field,
  inputClass,
  LossWarning,
  NewPassphrase,
  Screen,
} from './components.tsx';

/** Recovery from the published backup (spec 6.1, 11.3). */
export function RecoverScreen(props: { deps: SetupDeps; onDone: () => void; onBack: () => void }) {
  const { deps } = props;
  const [relayUrl, setRelayUrl] = useState('');
  const [npub, setNpub] = useState('');
  const [code, setCode] = useState('');
  const [opened, setOpened] = useState<{ fetched: FetchedBackup; key: Uint8Array }>();
  const [passphrase, setPassphrase] = useState('');
  const [again, setAgain] = useState('');
  const [result, setResult] = useState<RecoverResult>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<void>) => {
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

  if (result !== undefined) {
    return (
      <Screen title="Queue recovered">
        <p class="mt-2 text-sm">This device holds the queue key and is unlocked.</p>
        {!result.relayListFound && (
          <p class="mt-2 text-sm">
            The queue’s relay list was not found, so this device uses the relay you entered.
          </p>
        )}
        {!result.settingsFound && (
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

  if (opened !== undefined) {
    const strength = checkPassphrase(passphrase);
    const problem = !strength.ok
      ? strength.problem
      : again !== '' && again !== passphrase
        ? 'The two entries differ.'
        : undefined;
    const finish = (event: Event) => {
      event.preventDefault();
      void run(async () => {
        setResult(await finishRecover(opened.fetched, opened.key, passphrase, deps));
      });
    };
    return (
      <Screen title="Choose a passphrase">
        <form onSubmit={finish}>
          <p class="mt-2 text-sm">The recovery code opened the backup.</p>
          <NewPassphrase
            value={passphrase}
            confirm={again}
            problem={problem}
            onInput={setPassphrase}
            onConfirm={setAgain}
          />
          <LossWarning />
          <ErrorText message={error} />
          <Button
            type="submit"
            class="mt-3"
            disabled={busy || !strength.ok || again !== passphrase}
          >
            {busy ? 'Saving…' : 'Finish'}
          </Button>
        </form>
      </Screen>
    );
  }

  const open = (event: Event) => {
    event.preventDefault();
    void run(async () => {
      const fetched = await fetchRecoveryBackup({ relayUrl, npub }, deps);
      const key = openRecoveryBackup(fetched, code);
      setCode('');
      setOpened({ fetched, key });
    });
  };
  return (
    <Screen title="Recover a queue" onBack={props.onBack}>
      <form onSubmit={open}>
        <Field id="recover-relay" label="One of the queue’s storage relays">
          <input
            id="recover-relay"
            class={inputClass}
            spellcheck={false}
            placeholder="wss://nos.lol"
            value={relayUrl}
            onInput={(e) => setRelayUrl(e.currentTarget.value)}
          />
        </Field>
        <Field id="recover-npub" label="The queue’s npub">
          <input
            id="recover-npub"
            class={inputClass}
            spellcheck={false}
            value={npub}
            onInput={(e) => setNpub(e.currentTarget.value)}
          />
        </Field>
        <Field
          id="recover-code"
          label="Recovery code"
          hint="The 12 words, or the 26-character code."
        >
          <textarea
            id="recover-code"
            rows={3}
            class={inputClass}
            spellcheck={false}
            autocomplete="off"
            value={code}
            aria-describedby="recover-code-hint"
            onInput={(e) => setCode(e.currentTarget.value)}
          />
        </Field>
        <ErrorText message={error} />
        <Button
          type="submit"
          class="mt-3"
          disabled={busy || relayUrl.trim() === '' || npub.trim() === '' || code.trim() === ''}
        >
          {busy ? 'Opening the backup…' : 'Recover'}
        </Button>
      </form>
    </Screen>
  );
}

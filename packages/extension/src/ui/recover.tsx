import { useState } from 'preact/hooks';
import type { SetupDeps } from '../setup/deps.ts';
import { cleanRelayUrl, SetupError } from '../setup/deps.ts';
import {
  BackupNotFound,
  type FetchedBackup,
  findRecoveryBackup,
  finishRecover,
  openRecoveryBackup,
  type RecoverResult,
} from '../setup/recover.ts';
import { type ParsedRecoveryInput, parseRecoverySheet } from '../setup/recoverySheet.ts';
import { messageOf } from './app.tsx';
import {
  Button,
  ErrorText,
  Field,
  inputClass,
  LossWarning,
  NewPassphrase,
  passphraseReady,
  Screen,
} from './components.tsx';

/** What the recovery box has found so far, in words, for the live region under it. */
export function foundSummary(parsed: ParsedRecoveryInput): string {
  const parts = [
    parsed.npub !== undefined ? 'Queue ID found' : 'no Queue ID yet',
    parsed.code !== undefined ? 'recovery code found' : 'no recovery code yet',
  ];
  const n = parsed.storageRelays.length;
  if (n > 0) parts.push(`${n} storage server${n === 1 ? '' : 's'}`);
  const text = parts.join(', ');
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

/**
 * The relays to look the queue up on: the sheet's storage servers and the one typed, or none,
 * which means the default storage relays (9.1).
 */
export function lookupRelays(parsed: ParsedRecoveryInput, typedRelay: string): string[] {
  const relays = [...parsed.storageRelays];
  if (typedRelay.trim() !== '') {
    const clean = cleanRelayUrl(typedRelay);
    if (clean === undefined)
      throw new SetupError(`${typedRelay.trim()} is not a wss:// relay URL.`);
    if (!relays.includes(clean)) relays.unshift(clean);
  }
  return relays;
}

/** Recovery from the published backup (spec 6.1, 11.3). */
export function RecoverScreen(props: { deps: SetupDeps; onDone: () => void; onBack: () => void }) {
  const { deps } = props;
  const [text, setText] = useState('');
  const [relayUrl, setRelayUrl] = useState('');
  const [needRelay, setNeedRelay] = useState(false);
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
      if (e instanceof BackupNotFound && e.askedDefaults) setNeedRelay(true);
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
            The queue’s relay list was not found, so this device uses the relays it found the backup
            on.
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
    const ready = passphraseReady(passphrase, again);
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
            onInput={setPassphrase}
            onConfirm={setAgain}
          />
          <LossWarning />
          <ErrorText message={error} />
          <Button type="submit" class="mt-3" disabled={busy || !ready}>
            {busy ? 'Saving…' : 'Finish'}
          </Button>
        </form>
      </Screen>
    );
  }

  const parsed = parseRecoverySheet(text);
  const open = (event: Event) => {
    event.preventDefault();
    void run(async () => {
      if (parsed.npub === undefined) {
        throw new SetupError(
          'No Queue ID found: it starts with npub1 and is on your recovery sheet.'
        );
      }
      if (parsed.code === undefined) {
        throw new SetupError(
          'No recovery code found: the 12 words, or the 26-character code, from your recovery sheet.'
        );
      }
      if (parsed.conflict !== undefined) throw new SetupError(parsed.conflict);
      const relays = lookupRelays(parsed, relayUrl);
      const fetched = await findRecoveryBackup({ npub: parsed.npub, relays }, deps);
      const key = openRecoveryBackup(fetched, parsed.code);
      setText('');
      setOpened({ fetched, key });
    });
  };
  return (
    <Screen title="Recover a queue" onBack={props.onBack}>
      <form onSubmit={open}>
        <Field
          id="recover-sheet"
          label="Your recovery sheet"
          hint="Paste the whole sheet, or type the Queue ID (starts with npub1) and the recovery code (12 words, or 26 letters and digits)."
        >
          <textarea
            id="recover-sheet"
            rows={8}
            class={`${inputClass} font-mono`}
            spellcheck={false}
            autocomplete="off"
            value={text}
            aria-describedby="recover-sheet-hint recover-sheet-found"
            onInput={(e) => setText(e.currentTarget.value)}
          />
        </Field>
        <p id="recover-sheet-found" class="mt-1 text-muted text-xs" aria-live="polite">
          {text.trim() === '' ? '' : foundSummary(parsed)}
        </p>
        {needRelay && (
          <Field
            id="recover-relay"
            label="One of the queue’s storage servers"
            hint="On your recovery sheet under Storage servers; starts with wss://."
          >
            <input
              id="recover-relay"
              class={`${inputClass} font-mono`}
              spellcheck={false}
              placeholder="wss://"
              value={relayUrl}
              aria-describedby="recover-relay-hint"
              onInput={(e) => setRelayUrl(e.currentTarget.value)}
            />
          </Field>
        )}
        <ErrorText message={error} />
        <Button
          type="submit"
          class="mt-3"
          disabled={
            busy ||
            text.trim() === '' ||
            (needRelay && relayUrl.trim() === '' && parsed.storageRelays.length === 0)
          }
        >
          {busy ? 'Looking up the queue…' : 'Recover'}
        </Button>
      </form>
    </Screen>
  );
}

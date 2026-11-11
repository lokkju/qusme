import type { ProbeResult } from '@qusme/nostr';
import { useEffect, useState } from 'preact/hooks';
import {
  type CreateDraft,
  cleanRelayList,
  confirmRecoveryCode,
  DEFAULT_INBOX_RELAYS,
  DEFAULT_STORAGE_RELAYS,
  finishCreate,
  probeRelays,
  startCreate,
  wipeDraft,
} from '../setup/create.ts';
import type { SetupDeps } from '../setup/deps.ts';
import {
  type RecoverySheet,
  recoverySheetFilename,
  recoverySheetHtml,
  recoverySheetText,
} from '../setup/recoverySheet.ts';
import { messageOf } from './app.tsx';
import {
  Button,
  CopyButton,
  ErrorText,
  Field,
  inputClass,
  LossWarning,
  NewPassphrase,
  ProbeResults,
  passphraseReady,
  Screen,
  saveFile,
} from './components.tsx';

/**
 * The create flow (spec 11.3): passphrase, relays, the recovery sheet, then the typed
 * confirmation, which publishes. The relays come before the sheet so the sheet names the relays
 * the queue is actually created on.
 */
type Step = 'passphrase' | 'relays' | 'sheet' | 'confirm' | 'done';

const lines = (text: string): string[] => text.split(/\s+/).filter(Boolean);

/** The Queue ID and the storage servers, as the sheet and confirm steps show them. */
export function QueueFacts(props: { npub: string; storageRelays: readonly string[] }) {
  return (
    <dl class="mt-3 flex flex-col gap-1 text-sm">
      <dt class="font-semibold text-ink-2 text-xs uppercase">Queue ID (npub)</dt>
      <dd class="break-all font-mono text-xs">{props.npub}</dd>
      <dt class="mt-2 font-semibold text-ink-2 text-xs uppercase">Storage servers (relays)</dt>
      {props.storageRelays.map((url) => (
        <dd key={url} class="font-mono text-xs">
          {url}
        </dd>
      ))}
    </dl>
  );
}

/** The sheet step's content: the code in both forms, the Queue ID, the relays and the save controls. */
export function RecoverySheetView(props: { sheet: RecoverySheet }) {
  const { sheet } = props;
  return (
    <>
      <div class="mt-3 card p-3">
        <p class="font-semibold text-ink-2 text-xs uppercase">Recovery code</p>
        <ol class="mt-1 grid list-decimal grid-cols-3 gap-x-6 gap-y-1 pl-6 font-mono text-sm">
          {sheet.words.map((word, i) => (
            <li key={i}>{word}</li>
          ))}
        </ol>
        <p class="mt-2 text-xs">The same code, for printing:</p>
        <p class="font-mono text-sm">{sheet.base32}</p>
        <QueueFacts npub={sheet.npub} storageRelays={sheet.storageRelays} />
      </div>
      <div class="mt-3 flex flex-wrap gap-2">
        <Button
          onClick={() =>
            saveFile(
              recoverySheetFilename(sheet.createdAt, 'txt'),
              'text/plain;charset=utf-8',
              recoverySheetText(sheet)
            )
          }
        >
          Download recovery sheet
        </Button>
        <Button
          variant="plain"
          onClick={() =>
            saveFile(
              recoverySheetFilename(sheet.createdAt, 'html'),
              'text/html;charset=utf-8',
              recoverySheetHtml(sheet)
            )
          }
        >
          Printable version
        </Button>
        <CopyButton text={recoverySheetText(sheet)} />
      </div>
    </>
  );
}

export function CreateScreen(props: {
  deps: SetupDeps;
  onDone: () => void;
  onBack: () => void;
  /** Tests pass a deterministic passphrase suggestion. */
  suggest?: () => string;
}) {
  const { deps } = props;
  const [draft] = useState<CreateDraft>(() => startCreate());
  const [createdAt] = useState(() => new Date());
  const [step, setStep] = useState<Step>('passphrase');
  const [passphrase, setPassphrase] = useState('');
  const [again, setAgain] = useState('');
  const [saved, setSaved] = useState(false);
  const [typed, setTyped] = useState('');
  const [storage, setStorage] = useState(DEFAULT_STORAGE_RELAYS.join('\n'));
  const [inbox, setInbox] = useState(DEFAULT_INBOX_RELAYS.join('\n'));
  const [chosen, setChosen] = useState<{ storage: string[]; inbox: string[] }>();
  const [results, setResults] = useState<ProbeResult[]>([]);
  const [probedFor, setProbedFor] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  // An abandoned setup leaves no key material behind in memory it can reach.
  useEffect(() => () => wipeDraft(draft), [draft]);

  const relayKey = `${storage}\n--\n${inbox}`;
  const probesPassed = probedFor === relayKey && results.length > 0 && results.every((r) => r.ok);

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

  if (step === 'passphrase') {
    return (
      <Screen title="Create a queue" onBack={props.onBack}>
        <p class="mt-2 text-sm">
          The passphrase unlocks the queue on this device. It never leaves it.
        </p>
        <NewPassphrase
          value={passphrase}
          confirm={again}
          onInput={setPassphrase}
          onConfirm={setAgain}
          {...(props.suggest && { suggest: props.suggest })}
        />
        <LossWarning />
        <Button
          class="mt-3"
          disabled={!passphraseReady(passphrase, again)}
          onClick={() => setStep('relays')}
        >
          Next
        </Button>
      </Screen>
    );
  }

  if (step === 'relays') {
    const probe = () =>
      run(async () => {
        const storageRelays = cleanRelayList(lines(storage), 'storage relay');
        const inboxRelays = cleanRelayList(lines(inbox), 'inbox relay');
        setResults([]);
        const all = await probeRelays(
          [
            ...storageRelays.map((url) => ({ url, role: 'storage' as const })),
            ...inboxRelays.map((url) => ({ url, role: 'inbox' as const })),
          ],
          deps
        );
        setResults(all);
        setProbedFor(relayKey);
      });
    const next = () => {
      setError(undefined);
      setChosen({
        storage: cleanRelayList(lines(storage), 'storage relay'),
        inbox: cleanRelayList(lines(inbox), 'inbox relay'),
      });
      // New relays make a new sheet, which the user has to save again.
      setSaved(false);
      setStep('sheet');
    };
    return (
      <Screen title="Choose relays" onBack={() => setStep('passphrase')}>
        <p class="mt-2 text-sm">
          Storage relays hold the encrypted queue. The inbox relay receives drafts from agents and
          must show them only to you. Each is checked before it is saved.
        </p>
        <Field id="storage-relays" label="Storage relays, one per line">
          <textarea
            id="storage-relays"
            rows={3}
            class={`${inputClass} font-mono`}
            spellcheck={false}
            value={storage}
            onInput={(e) => setStorage(e.currentTarget.value)}
          />
        </Field>
        <Field id="inbox-relays" label="Inbox relay">
          <textarea
            id="inbox-relays"
            rows={1}
            class={`${inputClass} font-mono`}
            spellcheck={false}
            value={inbox}
            onInput={(e) => setInbox(e.currentTarget.value)}
          />
        </Field>
        {results.length > 0 && <ProbeResults results={results} />}
        <ErrorText message={error} />
        <div class="mt-3 flex gap-2">
          <Button variant={probesPassed ? 'plain' : 'primary'} disabled={busy} onClick={probe}>
            {busy ? 'Checking…' : 'Check relays'}
          </Button>
          <Button disabled={busy || !probesPassed} onClick={next}>
            Next
          </Button>
        </div>
      </Screen>
    );
  }

  const sheet: RecoverySheet = {
    words: draft.words,
    base32: draft.base32,
    npub: draft.npub,
    storageRelays: chosen?.storage ?? [],
    inboxRelays: chosen?.inbox ?? [],
    createdAt,
  };

  if (step === 'sheet') {
    return (
      <Screen title="Save your recovery sheet" onBack={() => setStep('relays')}>
        <p class="mt-2 text-sm">
          If you lose this device or forget the passphrase, you need all of this to get your queue
          back: the recovery code, the Queue ID and a storage server. The code is shown only now,
          and this device does not keep it. Download the sheet, or write it down.
        </p>
        <RecoverySheetView sheet={sheet} />
        <Button class="mt-3" onClick={() => setStep('confirm')}>
          Next
        </Button>
      </Screen>
    );
  }

  if (step === 'confirm') {
    const submit = (event: Event) => {
      event.preventDefault();
      if (!confirmRecoveryCode(draft, typed)) {
        setError('That is not the code shown. Check what you wrote down.');
        return;
      }
      void run(async () => {
        await finishCreate(
          draft,
          {
            passphrase,
            storageRelays: [...sheet.storageRelays],
            inboxRelays: [...sheet.inboxRelays],
          },
          deps
        );
        setPassphrase('');
        setAgain('');
        setTyped('');
        setStep('done');
      });
    };
    return (
      <Screen title="Confirm and create" onBack={() => setStep('sheet')}>
        <form onSubmit={submit}>
          <p class="mt-2 text-sm">
            Check that your sheet has this Queue ID and these storage servers.
          </p>
          <QueueFacts npub={sheet.npub} storageRelays={sheet.storageRelays} />
          <Field
            id="code-typed"
            label="Type the recovery code"
            hint="The 12 words, or the 26-character code."
          >
            <textarea
              id="code-typed"
              rows={3}
              class={`${inputClass} font-mono`}
              autocomplete="off"
              spellcheck={false}
              value={typed}
              aria-describedby="code-typed-hint"
              onInput={(e) => setTyped(e.currentTarget.value)}
            />
          </Field>
          <div class="mt-3 flex items-start gap-2">
            <input
              id="sheet-saved"
              type="checkbox"
              class="mt-1"
              checked={saved}
              onChange={(e) => setSaved(e.currentTarget.checked)}
            />
            <label for="sheet-saved" class="text-sm">
              I saved the recovery code and the recovery sheet somewhere other than this computer
            </label>
          </div>
          <ErrorText message={error} />
          <div class="mt-3 flex gap-2">
            <Button type="submit" disabled={busy || !saved || typed.trim() === ''}>
              {busy ? 'Creating…' : 'Create queue'}
            </Button>
            {error !== undefined && draft.confirmed && (
              <Button variant="plain" disabled={busy} onClick={() => setStep('relays')}>
                Change relays
              </Button>
            )}
          </div>
        </form>
      </Screen>
    );
  }

  return (
    <Screen title="Queue created">
      <p class="mt-2 text-sm">This device holds the queue key and is unlocked.</p>
      <Button class="mt-3" onClick={props.onDone}>
        Done
      </Button>
    </Screen>
  );
}

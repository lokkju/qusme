import type { ProbeResult } from '@qusme/nostr';
import { useEffect, useState } from 'preact/hooks';
import {
  type CreateDraft,
  cleanRelayList,
  confirmRecoveryCode,
  confirmRecoveryWords,
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
import { FirstRunChecklist, listJoin, serverHost } from './firstRun.tsx';

/**
 * The create flow (spec 11.3): passphrase, servers, the recovery sheet, then the typed
 * confirmation, which publishes, and the first-run checklist. The servers come before the sheet
 * so the sheet names the servers the queue is actually created on. The server step checks the
 * suggested servers as it opens and shows one line; editing them is under "Use other servers"
 * (critique F2). The confirmation asks for three of the twelve words, or the whole code (F3).
 */
type Step = 'passphrase' | 'relays' | 'sheet' | 'confirm' | 'done';

const lines = (text: string): string[] => text.split(/\s+/).filter(Boolean);

/** The Queue ID and the storage servers, as the sheet and confirm steps show them. */
export function QueueFacts(props: { npub: string; storageRelays: readonly string[] }) {
  return (
    <dl class="mt-3 flex flex-col gap-1 text-sm">
      <dt class="font-semibold text-ink-2 text-xs uppercase">Queue ID</dt>
      <dd class="break-all font-mono text-xs">{props.npub}</dd>
      <dt class="mt-2 font-semibold text-ink-2 text-xs uppercase">Storage servers</dt>
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

const sameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/** "Word 3, 7 and 11": the positions the confirmation asks for, counted from 1. */
const wordNumbers = (positions: readonly number[]) => listJoin(positions.map((p) => String(p + 1)));

export function CreateScreen(props: {
  deps: SetupDeps;
  /** Leaves the flow from its last step ("Go to drafts"). */
  onDone: () => void;
  onBack: () => void;
  /** The checklist's "Add by hand" and "Pair" on the last step; both go home without them. */
  onAddAccount?: () => void;
  onPair?: () => void;
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
  // The confirmation: three words by default, or the whole code in either form.
  const [confirmBy, setConfirmBy] = useState<'words' | 'code'>('words');
  const [typedWords, setTypedWords] = useState<string[]>(['', '', '']);
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
  const probed = probedFor === relayKey && results.length > 0;
  const probesPassed = probed && results.every((r) => r.ok);

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

  const probe = () =>
    run(async () => {
      const storageRelays = cleanRelayList(lines(storage), 'storage server');
      const inboxRelays = cleanRelayList(lines(inbox), 'inbox server');
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

  // The server step checks what it would use as soon as it opens, so the user has nothing to
  // press unless a server fails or they want others (critique F2).
  useEffect(() => {
    if (step === 'relays' && probedFor !== relayKey && !busy) void probe();
  }, [step]);

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
    const next = () => {
      setError(undefined);
      setChosen({
        storage: cleanRelayList(lines(storage), 'storage server'),
        inbox: cleanRelayList(lines(inbox), 'inbox server'),
      });
      // New servers make a new sheet, which the user has to save again.
      setSaved(false);
      setStep('sheet');
    };
    const storageHosts = lines(storage).map(serverHost);
    const inboxHosts = lines(inbox).map(serverHost);
    const suggested =
      sameList(lines(storage), DEFAULT_STORAGE_RELAYS) &&
      sameList(lines(inbox), DEFAULT_INBOX_RELAYS);
    const failed = probed && !probesPassed;
    const count = `${storageHosts.length} ${suggested ? 'public ' : ''}${storageHosts.length === 1 ? 'server' : 'servers'}`;
    return (
      <Screen title="Storage servers" onBack={() => setStep('passphrase')}>
        <p class="mt-2 text-sm">
          Your queue is kept encrypted on storage servers, and drafts from your agents arrive
          through an inbox server. Only your devices can read either.
        </p>
        <div role="status" class="mt-3 card p-3" data-server-check>
          <p class="flex items-center gap-2 font-semibold text-sm">
            {probesPassed && (
              <span
                aria-hidden="true"
                class="flex h-5 w-5 flex-none items-center justify-center rounded-full bg-accent text-on-accent text-xs"
              >
                ✓
              </span>
            )}
            {busy
              ? `Checking ${count}…`
              : probesPassed
                ? `${count}, checked`
                : failed
                  ? `${results.filter((r) => !r.ok).length} of ${results.length} servers didn't pass the check`
                  : count}
          </p>
          <p class="mt-1 text-ink-2 text-xs">
            Stored on {listJoin(storageHosts)}; drafts arrive through {listJoin(inboxHosts)}.
          </p>
        </div>
        {failed && <ProbeResults results={results} />}
        <details class="mt-3 text-sm" open={failed || !suggested}>
          <summary class="cursor-pointer text-muted text-xs">Use other servers</summary>
          <Field id="storage-relays" label="Storage servers, one per line">
            <textarea
              id="storage-relays"
              rows={3}
              class={`${inputClass} font-mono`}
              spellcheck={false}
              value={storage}
              onInput={(e) => setStorage(e.currentTarget.value)}
            />
          </Field>
          <Field id="inbox-relays" label="Inbox server">
            <textarea
              id="inbox-relays"
              rows={1}
              class={`${inputClass} font-mono`}
              spellcheck={false}
              value={inbox}
              onInput={(e) => setInbox(e.currentTarget.value)}
            />
          </Field>
          <Button
            variant="plain"
            size="sm"
            class="mt-2"
            disabled={busy || probesPassed}
            onClick={() => void probe()}
          >
            {busy ? 'Checking…' : 'Check servers'}
          </Button>
        </details>
        <ErrorText message={error} />
        <Button class="mt-3" disabled={busy || !probesPassed} onClick={next}>
          Next
        </Button>
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
    const positions = draft.checkPositions;
    const submit = (event: Event) => {
      event.preventDefault();
      const ok =
        confirmBy === 'words'
          ? confirmRecoveryWords(draft, typedWords)
          : confirmRecoveryCode(draft, typed);
      if (!ok) {
        setError(
          confirmBy === 'words'
            ? `Those aren't words ${wordNumbers(positions)} of the code shown. Check what you wrote down.`
            : 'That is not the code shown. Check what you wrote down.'
        );
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
        setTypedWords(['', '', '']);
        setStep('done');
      });
    };
    const entered =
      confirmBy === 'words' ? typedWords.every((w) => w.trim() !== '') : typed.trim() !== '';
    return (
      <Screen title="Confirm and create" onBack={() => setStep('sheet')}>
        <form onSubmit={submit}>
          <p class="mt-2 text-sm">
            Check that your sheet has this Queue ID and these storage servers.
          </p>
          <QueueFacts npub={sheet.npub} storageRelays={sheet.storageRelays} />
          {confirmBy === 'words' ? (
            <fieldset class="mt-3">
              <legend class="font-medium text-sm">
                Type words {wordNumbers(positions)} of your recovery code
              </legend>
              <div class="mt-1 grid grid-cols-3 gap-2">
                {positions.map((position, i) => (
                  <div key={position} class="flex flex-col gap-1">
                    <label for={`check-word-${i}`} class="text-muted text-xs">
                      Word {position + 1}
                    </label>
                    <input
                      id={`check-word-${i}`}
                      class={`${inputClass} font-mono`}
                      autocomplete="off"
                      autocapitalize="off"
                      spellcheck={false}
                      value={typedWords[i]}
                      onInput={(e) => {
                        const value = e.currentTarget.value;
                        setTypedWords((words) => words.map((w, j) => (j === i ? value : w)));
                      }}
                    />
                  </div>
                ))}
              </div>
              <p class="mt-1 text-xs">
                <button
                  type="button"
                  class="link"
                  onClick={() => {
                    setError(undefined);
                    setConfirmBy('code');
                  }}
                >
                  Type the whole code instead
                </button>
              </p>
            </fieldset>
          ) : (
            <>
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
              <p class="mt-1 text-xs">
                <button
                  type="button"
                  class="link"
                  onClick={() => {
                    setError(undefined);
                    setConfirmBy('words');
                  }}
                >
                  Type three words instead
                </button>
              </p>
            </>
          )}
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
            <Button type="submit" disabled={busy || !saved || !entered}>
              {busy ? 'Creating…' : 'Create queue'}
            </Button>
            {error !== undefined && draft.confirmed && (
              <Button variant="plain" disabled={busy} onClick={() => setStep('relays')}>
                Change servers
              </Button>
            )}
          </div>
        </form>
      </Screen>
    );
  }

  // The last step is the first-run checklist, with the queue as its first, ticked line (F6).
  return (
    <section class="flex flex-col" aria-labelledby="first-run-title">
      <FirstRunChecklist
        deps={deps}
        dismissible={false}
        onAddDestination={props.onAddAccount ?? props.onDone}
        onPair={props.onPair ?? props.onDone}
      />
      <Button class="mt-4" onClick={props.onDone}>
        Go to drafts
      </Button>
    </section>
  );
}

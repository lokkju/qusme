import type { ProbeResult } from '@qusme/nostr';
import { useEffect, useState } from 'preact/hooks';
import { checkPassphrase } from '../passphrase.ts';
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
import { messageOf } from './app.tsx';
import {
  Button,
  ErrorText,
  Field,
  inputClass,
  LossWarning,
  NewPassphrase,
  ProbeResults,
  Screen,
} from './components.tsx';

type Step = 'passphrase' | 'code' | 'confirm' | 'relays' | 'done';

const lines = (text: string): string[] => text.split(/\s+/).filter(Boolean);

export function CreateScreen(props: { deps: SetupDeps; onDone: () => void; onBack: () => void }) {
  const { deps } = props;
  const [draft] = useState<CreateDraft>(() => startCreate());
  const [step, setStep] = useState<Step>('passphrase');
  const [passphrase, setPassphrase] = useState('');
  const [again, setAgain] = useState('');
  const [saved, setSaved] = useState(false);
  const [typed, setTyped] = useState('');
  const [storage, setStorage] = useState(DEFAULT_STORAGE_RELAYS.join('\n'));
  const [inbox, setInbox] = useState(DEFAULT_INBOX_RELAYS.join('\n'));
  const [results, setResults] = useState<ProbeResult[]>([]);
  const [probedFor, setProbedFor] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  // An abandoned setup leaves no key material behind in memory it can reach.
  useEffect(() => () => wipeDraft(draft), [draft]);

  const strength = checkPassphrase(passphrase);
  const problem =
    passphrase === ''
      ? 'At least 12 characters; a few unrelated words work well.'
      : !strength.ok
        ? strength.problem
        : again !== '' && again !== passphrase
          ? 'The two entries differ.'
          : undefined;
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
          problem={problem}
          onInput={setPassphrase}
          onConfirm={setAgain}
        />
        <LossWarning />
        <Button
          class="mt-3"
          disabled={!strength.ok || again !== passphrase}
          onClick={() => setStep('code')}
        >
          Next
        </Button>
      </Screen>
    );
  }

  if (step === 'code') {
    return (
      <Screen title="Your recovery code">
        <p class="mt-2 text-sm">
          Write this down and keep it somewhere safe. It is shown only now, and this device does not
          keep it. With it you can restore the queue on a new device, or if you forget the
          passphrase.
        </p>
        <ol class="mt-3 grid list-decimal grid-cols-3 gap-x-6 gap-y-1 pl-6 font-mono text-sm">
          {draft.words.map((word, i) => (
            <li key={i}>{word}</li>
          ))}
        </ol>
        <p class="mt-3 text-sm">The same code for printing:</p>
        <p class="font-mono text-sm">{draft.base32}</p>
        <div class="mt-3 flex items-center gap-2">
          <input
            id="code-saved"
            type="checkbox"
            checked={saved}
            onChange={(e) => setSaved(e.currentTarget.checked)}
          />
          <label for="code-saved" class="text-sm">
            I saved the recovery code
          </label>
        </div>
        <Button class="mt-3" disabled={!saved} onClick={() => setStep('confirm')}>
          Next
        </Button>
      </Screen>
    );
  }

  if (step === 'confirm') {
    const submit = (event: Event) => {
      event.preventDefault();
      if (confirmRecoveryCode(draft, typed)) {
        setTyped('');
        setError(undefined);
        setStep('relays');
      } else {
        setError('That is not the code shown. Check what you wrote down.');
      }
    };
    return (
      <Screen title="Confirm the recovery code" onBack={() => setStep('code')}>
        <form onSubmit={submit}>
          <Field
            id="code-typed"
            label="Type the recovery code"
            hint="The 12 words, or the 26-character code."
          >
            <textarea
              id="code-typed"
              rows={3}
              class={inputClass}
              autocomplete="off"
              spellcheck={false}
              value={typed}
              aria-describedby="code-typed-hint"
              onInput={(e) => setTyped(e.currentTarget.value)}
            />
          </Field>
          <ErrorText message={error} />
          <Button type="submit" class="mt-3" disabled={typed.trim() === ''}>
            Confirm
          </Button>
        </form>
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
    const create = () =>
      run(async () => {
        await finishCreate(
          draft,
          { passphrase, storageRelays: lines(storage), inboxRelays: lines(inbox) },
          deps
        );
        setPassphrase('');
        setAgain('');
        setStep('done');
      });
    return (
      <Screen title="Choose relays">
        <p class="mt-2 text-sm">
          Storage relays hold the encrypted queue. The inbox relay receives drafts from agents and
          must show them only to you. Each is checked before it is saved.
        </p>
        <Field id="storage-relays" label="Storage relays, one per line">
          <textarea
            id="storage-relays"
            rows={3}
            class={inputClass}
            spellcheck={false}
            value={storage}
            onInput={(e) => setStorage(e.currentTarget.value)}
          />
        </Field>
        <Field id="inbox-relays" label="Inbox relay">
          <textarea
            id="inbox-relays"
            rows={1}
            class={inputClass}
            spellcheck={false}
            value={inbox}
            onInput={(e) => setInbox(e.currentTarget.value)}
          />
        </Field>
        {results.length > 0 && <ProbeResults results={results} />}
        <ErrorText message={error} />
        <div class="mt-3 flex gap-2">
          <Button variant={probesPassed ? 'plain' : 'primary'} disabled={busy} onClick={probe}>
            {busy && !probesPassed ? 'Checking…' : 'Check relays'}
          </Button>
          <Button disabled={busy || !probesPassed} onClick={create}>
            {busy && probesPassed ? 'Creating…' : 'Create queue'}
          </Button>
        </div>
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

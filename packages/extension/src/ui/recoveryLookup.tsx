import { useEffect, useState } from 'preact/hooks';
import type { SetupDeps } from '../setup/deps.ts';
import { addRecoveryLookup, backupNeedsLookup } from '../setup/recover.ts';
import { messageOf } from './app.tsx';
import { Button, ErrorText, Field, inputClass } from './components.tsx';

/**
 * Offered on the home screen while the queue's backup predates the lookup tag (6.1): the user types
 * the recovery code once, and the backup is republished so the code alone finds the queue. The
 * device never keeps the code, so it can't do this on its own.
 */
export function RecoveryLookupCard(props: { deps: SetupDeps }) {
  const { deps } = props;
  const [needed, setNeeded] = useState(false);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    void deps.store.record().then((record) => setNeeded(backupNeedsLookup(record)));
  }, [deps]);

  if (done) {
    return (
      <p class="mt-3 card p-3 text-sm" role="status">
        Done: your recovery code alone now finds this queue.
      </p>
    );
  }
  if (!needed) return null;

  const submit = (event: Event) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    void addRecoveryLookup(code, deps)
      .then(() => {
        setCode('');
        setDone(true);
      })
      .catch((e: unknown) => setError(messageOf(e)))
      .finally(() => setBusy(false));
  };

  return (
    <form class="mt-3 card p-3" onSubmit={submit}>
      <p class="font-medium text-sm">Let the recovery code work on its own</p>
      <p class="mt-1 text-sm">
        This queue was made before the recovery code could find it by itself; today, recovering also
        needs the Queue ID. Type the code once to fix that. This device doesn’t keep it.
      </p>
      <Field
        id="lookup-code"
        label="Recovery code"
        hint="The 12 words, or the 26 letters and digits, from your recovery sheet."
      >
        <input
          id="lookup-code"
          class={inputClass}
          spellcheck={false}
          autocomplete="off"
          value={code}
          aria-describedby="lookup-code-hint"
          onInput={(e) => setCode(e.currentTarget.value)}
        />
      </Field>
      <ErrorText message={error} />
      <Button type="submit" class="mt-2" disabled={busy || code.trim() === ''}>
        {busy ? 'Updating the backup…' : 'Update the backup'}
      </Button>
    </form>
  );
}

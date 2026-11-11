/**
 * The notice for a storage relay that accepts nothing and the screen that replaces it (spec 9.1,
 * "A storage relay that accepts nothing"). Relay URLs and relay messages come from the network,
 * so each is a JSX text child, which Preact sets as text.
 */
import type { ProbeResult } from '@qusme/nostr';
import { useState } from 'preact/hooks';
import type { DeadRelay } from '../relays/health.ts';
import {
  recoverySheetFor,
  type SwapDeps,
  SwapProbeError,
  type SwapResult,
  suggestReplacements,
  swapStorageRelay,
} from '../relays/swap.ts';
import type { RecoverySheet } from '../setup/recoverySheet.ts';
import { messageOf } from './app.tsx';
import { Button, ErrorText, Field, inputClass, ProbeResults, Screen } from './components.tsx';
import { RecoverySheetView } from './create.tsx';

const day = (unix: number): string => new Date(unix * 1000).toISOString().slice(0, 10);

/** One line per dead relay, what was seen, and the offer to replace it. */
export function DeadRelayNotice(props: {
  relays: readonly DeadRelay[];
  onReplace?: ((url: string) => void) | undefined;
}) {
  return (
    <>
      {props.relays.map((relay) => (
        <div key={relay.url} role="alert" class="mb-2 card-danger p-3 text-danger text-sm">
          <p>
            The storage server <span class="break-all font-mono">{relay.url}</span> is keeping
            nothing: it accepted none of the last {relay.failures} saves, since {day(relay.since)},
            while another of your storage servers did. Your queue is safe there, but changes can't
            be saved everywhere until this server is replaced.
          </p>
          {relay.lastReason !== undefined && (
            <details class="mt-1 text-muted text-xs">
              <summary class="cursor-pointer">Details</summary>
              <p>Its last answer: {relay.lastReason}</p>
            </details>
          )}
          {props.onReplace !== undefined && (
            <Button size="sm" class="mt-2" onClick={() => props.onReplace?.(relay.url)}>
              Replace this server
            </Button>
          )}
        </div>
      ))}
    </>
  );
}

const OTHER = 'other';

/**
 * Choose a replacement (the defaults not already in the list, or one typed), check it with the
 * setup probe, copy the queue to it and switch; then offer a fresh recovery sheet, since the old
 * one names the dead server.
 */
export function RelaySwapScreen(props: {
  deps: SwapDeps;
  dead: string;
  current: readonly string[];
  onBack: () => void;
}) {
  const suggestions = suggestReplacements(props.current);
  const [choice, setChoice] = useState<string>(suggestions[0] ?? OTHER);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [probe, setProbe] = useState<ProbeResult | undefined>();
  const [result, setResult] = useState<SwapResult | undefined>();

  const replacement = choice === OTHER ? typed : choice;
  const swap = async () => {
    setBusy(true);
    setError(undefined);
    setProbe(undefined);
    try {
      setResult(await swapStorageRelay(props.deps, { dead: props.dead, replacement }));
    } catch (e) {
      if (e instanceof SwapProbeError) setProbe(e.probe);
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };

  if (result !== undefined) {
    return <SwapDone deps={props.deps} dead={props.dead} result={result} onBack={props.onBack} />;
  }

  return (
    <Screen title="Replace a storage server" onBack={props.onBack}>
      <p class="mt-2 text-sm">
        <span class="break-all font-mono">{props.dead}</span> accepts none of your queue's saves.
        This copies your drafts, destinations, settings, agents and recovery backup from your other
        storage server to a new one, then switches every device to it. Nothing is removed until the
        new server has kept everything.
      </p>
      <fieldset class="mt-3 flex flex-col gap-2 text-sm">
        <legend class="font-medium">New storage server</legend>
        {suggestions.map((url) => (
          <label key={url} class="flex items-center gap-2">
            <input
              type="radio"
              name="replacement"
              value={url}
              checked={choice === url}
              onChange={() => setChoice(url)}
            />
            <span class="font-mono">{url}</span>
          </label>
        ))}
        <label class="flex items-center gap-2">
          <input
            type="radio"
            name="replacement"
            value={OTHER}
            checked={choice === OTHER}
            onChange={() => setChoice(OTHER)}
          />
          Another server
        </label>
      </fieldset>
      {choice === OTHER && (
        <Field id="replacement-url" label="Server address">
          <input
            id="replacement-url"
            class={`${inputClass} font-mono`}
            placeholder="wss://"
            spellcheck={false}
            value={typed}
            onInput={(e) => setTyped(e.currentTarget.value)}
          />
        </Field>
      )}
      {probe !== undefined && <ProbeResults results={[probe]} />}
      <ErrorText message={error} />
      <Button class="mt-3" disabled={busy || replacement.trim() === ''} onClick={() => void swap()}>
        {busy ? 'Checking and copying…' : 'Check and replace'}
      </Button>
    </Screen>
  );
}

function SwapDone(props: { deps: SwapDeps; dead: string; result: SwapResult; onBack: () => void }) {
  const { result } = props;
  const c = result.copied;
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [sheet, setSheet] = useState<RecoverySheet | undefined>();
  const make = async (event: Event) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      setSheet(await recoverySheetFor(props.deps, code));
      setCode('');
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Screen title="Storage server replaced" onBack={props.onBack}>
      <p class="mt-2 text-sm" aria-live="polite">
        Your queue is now stored on {result.relays.join(' and ')}. Copied {c.drafts} drafts,
        {` ${c.grants}`} agent grants, the agent list, destinations, settings and the recovery
        backup. Your other devices switch on their next sync.
      </p>
      <h2 class="mt-4 font-semibold text-sm">Recovery sheet</h2>
      {sheet === undefined ? (
        <form onSubmit={make}>
          <p class="mt-1 text-sm">
            Your recovery sheet lists <span class="break-all font-mono">{props.dead}</span>. It
            still works while one of its servers is in the list, but a new sheet names the current
            ones. Type your recovery code to make it; the code stays the same.
          </p>
          <Field id="sheet-code" label="Recovery code (12 words or 26 characters)">
            <input
              id="sheet-code"
              type="password"
              autocomplete="off"
              spellcheck={false}
              class={`${inputClass} font-mono`}
              value={code}
              onInput={(e) => setCode(e.currentTarget.value)}
            />
          </Field>
          <ErrorText message={error} />
          <div class="mt-3 flex gap-2">
            <Button type="submit" disabled={busy || code.trim() === ''}>
              {busy ? 'Checking the code…' : 'Make a new recovery sheet'}
            </Button>
            <Button variant="plain" onClick={props.onBack}>
              Not now
            </Button>
          </div>
        </form>
      ) : (
        <>
          <RecoverySheetView sheet={sheet} />
          <Button class="mt-3" onClick={props.onBack}>
            Done
          </Button>
        </>
      )}
    </Screen>
  );
}

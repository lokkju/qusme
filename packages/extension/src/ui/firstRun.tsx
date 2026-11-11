/**
 * The first-run checklist on the unlocked home screen (src/firstRun.ts has the rules for each
 * item). It shows until every item is ticked or the user hides it.
 */
import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { AgentDeps } from '../agents/queue.ts';
import {
  type ChecklistState,
  checklistCount,
  checklistDone,
  loadChecklist,
  updateFirstRun,
} from '../firstRun.ts';
import { Button, CopyButton, inputClass } from './components.tsx';

/** The MCP endpoint a custom connector points at. */
export const mcpUrl = (serviceOrigin: string): string => `${serviceOrigin}/mcp`;

function Item(props: { done: boolean; title: string; children?: ComponentChildren }) {
  return (
    <li class="card p-3">
      <div class="flex items-center gap-2">
        <span
          aria-hidden="true"
          class={`flex h-5 w-5 flex-none items-center justify-center rounded-full text-on-accent text-xs ${props.done ? 'bg-accent' : 'border-2 border-line-strong'}`}
        >
          {props.done ? '✓' : ''}
        </span>
        <span class="font-semibold text-sm">{props.title}</span>
        <span class="sr-only">{props.done ? '(done)' : '(to do)'}</span>
      </div>
      {!props.done && props.children}
    </li>
  );
}

/** The checklist for a known state, without effects. */
export function ChecklistView(props: {
  state: ChecklistState;
  serviceOrigin: string;
  onAddDestination: () => void;
  onPair: () => void;
  onSkipPair: () => void;
  onDismiss: () => void;
}) {
  const { state } = props;
  if (checklistDone(state)) return null;
  const url = mcpUrl(props.serviceOrigin);
  return (
    <section class="mt-3" aria-labelledby="first-run-title">
      <div class="flex items-baseline justify-between">
        <h2 id="first-run-title" class="font-semibold">
          Get started
        </h2>
        <span class="text-muted text-xs">{checklistCount(state)} of 3 done</span>
      </div>
      <ul class="mt-2 flex flex-col gap-2">
        <Item done={state.agent} title="Connect Claude: add a custom connector">
          <p class="mt-2 text-ink-2 text-xs">
            In Claude: Settings, Connectors, Add custom connector, then paste this address. Claude
            then shows a code; enter it under “Approve an agent”.
          </p>
          <div class="mt-2 flex gap-2">
            <input
              readOnly
              aria-label="Connector address"
              class={`${inputClass} font-mono`}
              value={url}
            />
            <CopyButton text={url} />
          </div>
        </Item>
        <Item done={state.destination} title="Add your X account">
          <p class="mt-2 text-ink-2 text-xs">
            The account drafts go to. On x.com, the extension can read which account is signed in.
          </p>
          <Button class="mt-2" onClick={props.onAddDestination}>
            Add a destination
          </Button>
        </Item>
        <Item done={state.device} title="Pair your phone">
          <p class="mt-2 text-ink-2 text-xs">
            A second device keeps your queue if you lose this one, and shows your drafts there.
          </p>
          <div class="mt-2 flex gap-2">
            <Button onClick={props.onPair}>Pair</Button>
            <Button variant="plain" onClick={props.onSkipPair}>
              Skip
            </Button>
          </div>
        </Item>
      </ul>
      <Button variant="plain" size="xs" class="mt-2" onClick={props.onDismiss}>
        Hide this checklist
      </Button>
    </section>
  );
}

/** The checklist with its state read from storage, the relays and the service. */
export function FirstRunChecklist(props: {
  deps: AgentDeps;
  onAddDestination: () => void;
  onPair: () => void;
}) {
  const { deps } = props;
  const [state, setState] = useState<ChecklistState>();
  const [pubkey, setPubkey] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const record = await deps.store.record();
      const loaded = await loadChecklist(deps).catch(() => undefined);
      if (cancelled) return;
      setPubkey(record?.pubkey);
      setState(loaded);
    })();
    return () => {
      cancelled = true;
    };
  }, [deps]);

  if (state === undefined || pubkey === undefined) return null;
  const save = (patch: Parameters<typeof updateFirstRun>[2], next: Partial<ChecklistState>) => {
    setState({ ...state, ...next });
    void updateFirstRun(deps.store.local, pubkey, patch);
  };
  return (
    <ChecklistView
      state={state}
      serviceOrigin={deps.serviceOrigin}
      onAddDestination={props.onAddDestination}
      onPair={props.onPair}
      onSkipPair={() => save({ device: 'skipped' }, { device: true })}
      onDismiss={() => save({ dismissed: true }, { dismissed: true })}
    />
  );
}

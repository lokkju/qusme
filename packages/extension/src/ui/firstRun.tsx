/**
 * The first-run checklist (src/firstRun.ts has the rules for each item): the create flow's last
 * step, then the home list's empty state until every item is ticked or the user hides it
 * (critique F6, H7). The first line is the queue itself, always ticked, naming the servers it is
 * stored on.
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

/** A relay URL's host, for naming servers to the user ("relay.primal.net"). */
export function serverHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** "a", "a and b", "a, b and c". */
export function listJoin(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function Item(props: {
  done: boolean;
  title: string;
  note?: string;
  /** Shown under a ticked item too (the queue line names its servers). */
  detail?: string;
  children?: ComponentChildren;
}) {
  return (
    <li class="flex gap-3 border-line border-b py-3 last:border-b-0">
      <span
        aria-hidden="true"
        class={`mt-0.5 flex h-5 w-5 flex-none items-center justify-center rounded-full text-on-accent text-xs ${props.done ? 'bg-accent' : 'border-2 border-line-strong'}`}
      >
        {props.done ? '✓' : ''}
      </span>
      <div class="min-w-0 flex-1">
        <p class="text-sm">
          <span class="font-semibold">{props.title}</span>
          {props.note !== undefined && <span class="text-muted"> {props.note}</span>}
          <span class="sr-only">{props.done ? ' (done)' : ' (to do)'}</span>
        </p>
        {props.detail !== undefined && <p class="mt-0.5 text-ink-2 text-xs">{props.detail}</p>}
        {!props.done && props.children}
      </div>
    </li>
  );
}

/** The checklist for a known state, without effects. */
export function ChecklistView(props: {
  state: ChecklistState;
  serviceOrigin: string;
  /** The queue's storage relays, named by host on the first line. */
  servers?: readonly string[];
  onAddDestination: () => void;
  onPair: () => void;
  onSkipPair: () => void;
  /** Hides the checklist for good; the create flow's last step leaves it out. */
  onDismiss?: () => void;
}) {
  const { state } = props;
  if (checklistDone(state)) return null;
  const url = mcpUrl(props.serviceOrigin);
  const hosts = (props.servers ?? []).map(serverHost);
  return (
    <section class="mt-3" aria-labelledby="first-run-title">
      <h2 id="first-run-title" class="font-medium font-serif text-xl leading-tight">
        Your queue is ready
      </h2>
      <p class="mt-1 text-muted text-xs">
        Connect an agent and add your account, and drafts can start arriving.{' '}
        {checklistCount(state)} of 3 done.
      </p>
      <ul class="mt-1">
        <Item
          done
          title={
            hosts.length === 0
              ? 'Queue created'
              : `Queue stored on ${hosts.length} ${hosts.length === 1 ? 'server' : 'servers'}`
          }
          {...(hosts.length > 0 && { detail: `${listJoin(hosts)}.` })}
        />
        <Item done={state.agent} title="Connect an agent">
          <p class="mt-0.5 text-ink-2 text-xs">
            In your AI app, add a custom connector with this address. It then shows a code; open
            qus.me on that page to approve it.
          </p>
          <div class="mt-2 flex gap-2">
            <input
              readOnly
              aria-label="Connector address"
              class={`${inputClass} py-1.5 font-mono`}
              value={url}
            />
            <CopyButton text={url} size="sm" />
          </div>
        </Item>
        <Item done={state.destination} title="Add the account you post from">
          <p class="mt-0.5 text-ink-2 text-xs">
            Open x.com, Bluesky, Mastodon or LinkedIn signed in and click the qus.me button; it
            reads which account is signed in.
          </p>
          <Button variant="plain" size="sm" class="mt-2" onClick={props.onAddDestination}>
            Add by hand
          </Button>
        </Item>
        <Item done={state.device} title="Pair your phone" note="optional">
          <p class="mt-0.5 text-ink-2 text-xs">
            Keeps the queue if you lose this computer, and shows your drafts there.
          </p>
          <div class="mt-2 flex gap-2">
            <Button variant="plain" size="sm" onClick={props.onPair}>
              Pair
            </Button>
            <Button variant="plain" size="sm" onClick={props.onSkipPair}>
              Skip
            </Button>
          </div>
        </Item>
      </ul>
      {props.onDismiss !== undefined && (
        <Button variant="plain" size="xs" class="mt-1" onClick={props.onDismiss}>
          Hide this checklist
        </Button>
      )}
    </section>
  );
}

/** The checklist with its state read from storage, the relays and the service. */
export function FirstRunChecklist(props: {
  deps: AgentDeps;
  onAddDestination: () => void;
  onPair: () => void;
  /** False on the create flow's last step: Hide is left out there. */
  dismissible?: boolean;
  /** Reports whether the checklist is on screen, so the home list can drop its empty line. */
  onShown?: (shown: boolean) => void;
}) {
  const { deps } = props;
  const [state, setState] = useState<ChecklistState>();
  const [record, setRecord] = useState<{ pubkey: string; storageRelays: string[] }>();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const stored = await deps.store.record();
      const loaded = await loadChecklist(deps).catch(() => undefined);
      if (cancelled) return;
      if (stored !== undefined)
        setRecord({ pubkey: stored.pubkey, storageRelays: [...stored.storageRelays] });
      setState(loaded);
    })();
    return () => {
      cancelled = true;
    };
  }, [deps]);

  const shown = state !== undefined && record !== undefined && !checklistDone(state);
  useEffect(() => {
    props.onShown?.(shown);
  }, [shown]);

  if (state === undefined || record === undefined) return null;
  const save = (patch: Parameters<typeof updateFirstRun>[2], next: Partial<ChecklistState>) => {
    setState({ ...state, ...next });
    void updateFirstRun(deps.store.local, record.pubkey, patch);
  };
  return (
    <ChecklistView
      state={state}
      serviceOrigin={deps.serviceOrigin}
      servers={record.storageRelays}
      onAddDestination={props.onAddDestination}
      onPair={props.onPair}
      onSkipPair={() => save({ device: 'skipped' }, { device: true })}
      {...(props.dismissible !== false && {
        onDismiss: () => save({ dismissed: true }, { dismissed: true }),
      })}
    />
  );
}

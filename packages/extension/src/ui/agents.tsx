/**
 * Agent approval, the agents list and pending destinations (spec 8.2, 11.8). Client names, URLs,
 * agent labels and destination labels come from MCP clients, agents and relays, so every one is a
 * JSX text child, which Preact sets as text. The client ID's host is shown large next to the name,
 * since any client can call itself anything but cannot serve its document from another's host.
 */
import type { Destination, QuotaPeriod } from '@qusme/nostr';
import { createLocalSigner, MAX_SUBMISSION_EXPIRATION_DAYS, QUOTA_PERIODS } from '@qusme/nostr';
import { npubEncode } from 'nostr-tools/nip19';
import { useCallback, useEffect, useState } from 'preact/hooks';
import {
  type ApprovalChoices,
  approveAgent,
  DEFAULT_FIELDS,
  defaultChoices,
  denyAgent,
  sharesNothing,
} from '../agents/approve.ts';
import { parseApprovalCode } from '../agents/code.ts';
import {
  confirmPendingDestination,
  mergePendingDestination,
  rejectPendingDestination,
} from '../agents/destinations.ts';
import {
  choicesFromGrant,
  editGrant,
  type GrantEditStart,
  shareCandidates,
  shareDestination,
} from '../agents/grants.ts';
import { finishRevocation } from '../agents/pendingRevocations.ts';
import { NO_SERVICE_PERMISSION, type RevokeResult, revokeAgent } from '../agents/revoke.ts';
import { type AuthorizationRequest, fetchAuthorization } from '../agents/service.ts';
import {
  type AgentRow,
  type AgentsView,
  loadAgents,
  loadShareableDestinations,
} from '../agents/view.ts';
import { destinationLabel } from '../drafts/row.ts';
import type { SiteDefinitionSource } from '../insertion/definitions.ts';
import { type SetupDeps, SetupError } from '../setup/deps.ts';
import { messageOf } from './app.tsx';
import { Button, ErrorText, Field, inputClass, Screen } from './components.tsx';

const PERIOD_LABELS: Record<QuotaPeriod, string> = {
  day: 'per day',
  week: 'per week',
  month: 'per month',
};

const PERIOD_NOW: Record<QuotaPeriod, string> = {
  day: 'Today',
  week: 'This week',
  month: 'This month',
};

const shortNpub = (pubkey: string): string => {
  const npub = npubEncode(pubkey);
  return `${npub.slice(0, 12)}…${npub.slice(-6)}`;
};

const fieldsText = (fields: readonly string[]) => fields.join(', ');
const parseFields = (text: string) =>
  text
    .split(',')
    .map((f) => f.trim())
    .filter((f) => f !== '');

/** End of the chosen local day, as unix seconds; null when the date is empty. */
function expiryFromDate(value: string): number | null {
  if (value === '') return null;
  const time = new Date(`${value}T23:59:59`).getTime();
  return Number.isNaN(time) ? null : Math.floor(time / 1000);
}

function dateOf(expiresAt: number | null): string {
  if (expiresAt === null) return '';
  const d = new Date(expiresAt * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Who is asking, with the client ID's host large: any client can call itself anything, but it
 * can't serve its document from another's host. The rest of the request is under Details.
 */
export function RequestSummary(props: { request: AuthorizationRequest }) {
  const { request } = props;
  return (
    <div class="mt-3 card-band p-3">
      <p class="text-muted text-xs">Code {request.code} · this agent calls itself</p>
      <p class="font-semibold text-lg break-words">{request.clientName}</p>
      <p class="mt-2 text-muted text-xs">Published by (the host of its client ID)</p>
      <p class="font-mono font-bold text-2xl break-all" data-client-host>
        {request.clientHost}
      </p>
      <p class="mt-1 text-xs">
        Only approve if you just connected an agent from {request.clientHost}.
      </p>
      {request.clientName.toLowerCase() !== request.clientHost.toLowerCase() && (
        <p class="mt-2 text-muted text-xs">
          The name is whatever the client says it is. Approve only if you started this from a client
          you trust and the host above is the one you expect.
        </p>
      )}
      <details class="mt-2 text-xs">
        <summary class="cursor-pointer text-muted">Details</summary>
        <dl class="mt-1 grid grid-cols-[auto_1fr] gap-x-2 gap-y-1">
          <dt class="text-muted">Client ID</dt>
          <dd class="break-all font-mono">{request.clientId}</dd>
          {request.redirectHost !== undefined && (
            <>
              <dt class="text-muted">Returns to</dt>
              <dd class="break-all font-mono">{request.redirectHost}</dd>
            </>
          )}
          <dt class="text-muted">Scope</dt>
          <dd class="font-mono">{request.scopes.join(' ')}</dd>
          <dt class="text-muted">Agent key</dt>
          <dd class="font-mono">{shortNpub(request.agentPubkey)}</dd>
        </dl>
      </details>
    </div>
  );
}

/** Above Approve when the agent would be able to draft nothing (UX audit 4.7). */
export function NothingSharedWarning(props: { name: string }) {
  return (
    <div role="alert" class="mt-3 card-danger p-3">
      <p class="font-semibold text-sm">This agent won't be able to draft anything</p>
      <p class="mt-1 text-xs">
        Nothing is shared with {props.name} and it can't propose new destinations, so every draft it
        sends will be refused. Tick a destination or let it propose new ones; otherwise you'd have
        to revoke it and approve it again to share one later.
      </p>
    </div>
  );
}

/** The review step: who is asking, the grant form, the warning and the buttons. */
export function ApprovalReview(props: {
  request: AuthorizationRequest;
  destinations: Destination[];
  choices: ApprovalChoices;
  busy: string | undefined;
  error: string | undefined;
  onChange: (choices: ApprovalChoices) => void;
  onApprove: () => void;
  onDeny: () => void;
  onBack: () => void;
}) {
  const { choices } = props;
  const empty = sharesNothing(choices);
  return (
    <Screen title="Approve an agent" onBack={props.onBack}>
      <RequestSummary request={props.request} />
      <GrantForm destinations={props.destinations} choices={choices} onChange={props.onChange} />
      {empty && <NothingSharedWarning name={choices.label.trim() || props.request.clientName} />}
      <ErrorText message={props.error} />
      <div class="mt-4 flex gap-2">
        <Button onClick={props.onApprove} disabled={props.busy !== undefined}>
          {props.busy ?? (empty ? 'Approve anyway' : 'Approve')}
        </Button>
        <Button variant="danger" onClick={props.onDeny} disabled={props.busy !== undefined}>
          Deny
        </Button>
      </div>
    </Screen>
  );
}

/** After an approval: the steps that finished, and what the client does next on its own. */
export function ApprovalDone(props: { name: string; shared: string[]; onDone: () => void }) {
  const tick = (
    <span
      aria-hidden="true"
      class="flex h-5 w-5 flex-none items-center justify-center rounded-full bg-accent text-on-accent text-xs"
    >
      ✓
    </span>
  );
  return (
    <Screen title="Agent approved">
      <h2 class="mt-2 font-semibold text-base">{props.name} is connected</h2>
      <div role="status">
        <ol class="mt-3 flex flex-col gap-2 text-sm">
          <li class="flex items-center gap-2">
            {tick}
            <span>Saved to your queue</span>
          </li>
          <li class="flex items-center gap-2">
            {tick}
            <span>qus.me confirmed the approval</span>
          </li>
          <li class="flex items-center gap-2">
            {/* The extension can't see the client's tab; its authorize page redirects on its own. */}
            <span
              aria-hidden="true"
              class="flex h-5 w-5 flex-none items-center justify-center rounded-full border border-accent text-accent text-xs"
            >
              →
            </span>
            <span>{props.name} finishes signing in on its own: go back to its page</span>
          </li>
        </ol>
      </div>
      <p class="mt-3 text-muted text-xs">
        {props.shared.length === 0 ? 'Shared: nothing yet.' : `Shared: ${props.shared.join(', ')}.`}
      </p>
      <Button class="mt-4" onClick={props.onDone}>
        Back to drafts
      </Button>
    </Screen>
  );
}

/** The grant form: label, destinations with fields, the new-destinations toggle, limits. */
export function GrantForm(props: {
  destinations: Destination[];
  choices: ApprovalChoices;
  onChange: (choices: ApprovalChoices) => void;
}) {
  const { destinations, choices, onChange } = props;
  const set = (patch: Partial<ApprovalChoices>) => onChange({ ...choices, ...patch });
  const chosen = (id: string) => choices.destinations.find((d) => d.id === id);
  const toggle = (id: string, on: boolean) =>
    set({
      destinations: on
        ? [...choices.destinations, { id, fields: [...DEFAULT_FIELDS] }]
        : choices.destinations.filter((d) => d.id !== id),
    });
  const setFields = (id: string, text: string) =>
    set({
      destinations: choices.destinations.map((d) =>
        d.id === id ? { ...d, fields: parseFields(text) } : d
      ),
    });
  return (
    <>
      <Field id="agent-label" label="Label" hint="Only your devices see it.">
        <input
          id="agent-label"
          class={inputClass}
          value={choices.label}
          maxLength={100}
          aria-describedby="agent-label-hint"
          onInput={(e) => set({ label: e.currentTarget.value })}
        />
      </Field>

      <fieldset class="mt-3">
        <legend class="font-medium text-sm">Where it may draft</legend>
        {destinations.length === 0 ? (
          <p class="text-muted text-xs">
            The queue has no confirmed destinations yet. Without any, the agent can draft only if
            you allow new destinations below.
          </p>
        ) : (
          <ul class="mt-1 flex flex-col gap-2">
            {destinations.map((d) => {
              const choice = chosen(d.id);
              return (
                <li key={d.id} class="card p-3">
                  <label class="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={choice !== undefined}
                      onChange={(e) => toggle(d.id, e.currentTarget.checked)}
                    />
                    <span>{d.label}</span>
                  </label>
                  {choice !== undefined && (
                    <input
                      aria-label={`Fields for ${d.label}`}
                      class={`${inputClass} mt-1`}
                      value={fieldsText(choice.fields)}
                      onChange={(e) => setFields(d.id, e.currentTarget.value)}
                    />
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </fieldset>

      <div class="mt-3 flex items-start gap-2 card-tint p-3">
        <input
          id="allow-new-destinations"
          type="checkbox"
          class="mt-1"
          checked={choices.allowNewDestinations}
          aria-describedby="allow-new-destinations-hint"
          onChange={(e) => set({ allowNewDestinations: e.currentTarget.checked })}
        />
        <div>
          <label for="allow-new-destinations" class="font-medium text-sm">
            Let it propose new destinations
          </label>
          <p id="allow-new-destinations-hint" class="text-muted text-xs">
            Off: it drafts only where you chose above. On: it may draft for any site and account;
            each new one waits as pending until you confirm it.
          </p>
        </div>
      </div>

      <div class="grid grid-cols-2 gap-3">
        <Field id="quota-max" label="Quota">
          <input
            id="quota-max"
            type="number"
            min={1}
            class={inputClass}
            value={String(choices.quota.max_submissions)}
            onInput={(e) =>
              set({ quota: { ...choices.quota, max_submissions: Number(e.currentTarget.value) } })
            }
          />
        </Field>
        <Field id="quota-period" label="Period">
          <select
            id="quota-period"
            class={inputClass}
            value={choices.quota.period}
            onChange={(e) =>
              set({ quota: { ...choices.quota, period: e.currentTarget.value as QuotaPeriod } })
            }
          >
            {QUOTA_PERIODS.map((p) => (
              <option key={p} value={p}>
                {PERIOD_LABELS[p]}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field
        id="submission-expiration"
        label="Unread submissions expire after (days)"
        hint={`1 to ${MAX_SUBMISSION_EXPIRATION_DAYS}.`}
      >
        <input
          id="submission-expiration"
          type="number"
          min={1}
          max={MAX_SUBMISSION_EXPIRATION_DAYS}
          class={inputClass}
          value={String(choices.submissionExpirationDays)}
          aria-describedby="submission-expiration-hint"
          onInput={(e) => set({ submissionExpirationDays: Number(e.currentTarget.value) })}
        />
      </Field>
      <Field id="grant-expires" label="Access ends on" hint="Leave empty for no end date.">
        <input
          id="grant-expires"
          type="date"
          class={inputClass}
          value={dateOf(choices.expiresAt)}
          aria-describedby="grant-expires-hint"
          onInput={(e) => set({ expiresAt: expiryFromDate(e.currentTarget.value) })}
        />
      </Field>
    </>
  );
}

type ApprovePhase =
  | { phase: 'code' }
  | { phase: 'review'; request: AuthorizationRequest; destinations: Destination[] }
  | { phase: 'done'; approved: true; name: string; shared: string[] }
  | { phase: 'done'; approved: false };

/** Enter the code from the client's authorize page, review the request, approve or deny. */
export function ApproveAgentScreen(props: {
  deps: SetupDeps;
  initialCode?: string;
  onDone: () => void;
  onBack: () => void;
}) {
  const { deps } = props;
  const [input, setInput] = useState(props.initialCode ?? '');
  const [phase, setPhase] = useState<ApprovePhase>({ phase: 'code' });
  const [choices, setChoices] = useState<ApprovalChoices | undefined>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();

  if (phase.phase === 'code') {
    const lookUp = async (event: Event) => {
      event.preventDefault();
      setError(undefined);
      const code = parseApprovalCode(input, deps.serviceOrigin);
      if (code === undefined) {
        setError('Enter the 8-character code from the page, like ABCD-1234, or paste its link.');
        return;
      }
      setBusy('Looking up…');
      try {
        // First thing awaited in the gesture: Firefox grants the permission only inside it.
        if (!(await deps.requestServicePermission())) {
          throw new SetupError('qus.me needs permission to reach app.qus.me to look up the code.');
        }
        const unlocked = await deps.store.unlocked();
        if (unlocked === undefined) throw new SetupError('Unlock the queue first.');
        const [request, destinations] = await Promise.all([
          fetchAuthorization(createLocalSigner(unlocked.queueKey), code, deps),
          loadShareableDestinations(deps),
        ]);
        setChoices(defaultChoices(request, destinations));
        setPhase({ phase: 'review', request, destinations });
      } catch (e) {
        setError(messageOf(e));
      } finally {
        setBusy(undefined);
      }
    };
    return (
      <Screen title="Approve an agent" onBack={props.onBack}>
        <p class="mt-2 text-sm">
          Enter the code the MCP client's authorization page shows, or paste the link from its QR
          code.
        </p>
        <form onSubmit={lookUp}>
          <Field id="approval-code" label="Code or link">
            <input
              id="approval-code"
              class={`${inputClass} font-mono`}
              autocomplete="off"
              spellcheck={false}
              placeholder="ABCD-1234"
              value={input}
              onInput={(e) => setInput(e.currentTarget.value)}
            />
          </Field>
          <ErrorText message={error} />
          <Button type="submit" class="mt-3" disabled={busy !== undefined || input.trim() === ''}>
            {busy ?? 'Look up'}
          </Button>
        </form>
      </Screen>
    );
  }

  if (phase.phase === 'done') {
    if (phase.approved)
      return <ApprovalDone name={phase.name} shared={phase.shared} onDone={props.onDone} />;
    return (
      <Screen title="Request denied">
        <p class="mt-2 text-sm" role="status">
          The service destroyed the key it made for this request.
        </p>
        <Button class="mt-4" onClick={props.onDone}>
          Done
        </Button>
      </Screen>
    );
  }

  const { request, destinations } = phase;
  const approve = async () => {
    if (choices === undefined) return;
    setError(undefined);
    setBusy('Publishing…');
    try {
      await approveAgent(request, choices, deps);
      const shared = choices.destinations.flatMap(
        (c) => destinations.find((d) => d.id === c.id)?.label ?? []
      );
      setPhase({
        phase: 'done',
        approved: true,
        name: choices.label.trim() || request.clientName,
        shared,
      });
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(undefined);
    }
  };
  const deny = async () => {
    setError(undefined);
    setBusy('Denying…');
    try {
      await denyAgent(request, deps);
      setPhase({ phase: 'done', approved: false });
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(undefined);
    }
  };
  if (choices === undefined) return null;
  return (
    <ApprovalReview
      request={request}
      destinations={destinations}
      choices={choices}
      busy={busy}
      error={error}
      onChange={setChoices}
      onApprove={() => void approve()}
      onDeny={() => void deny()}
      onBack={props.onBack}
    />
  );
}

/** What the agents screen says after a revocation. */
export function revokeMessage(name: string, result: RevokeResult): string {
  const refused =
    result.refusals.length > 0 ? ` Some storage relays refused: ${result.refusals.join('; ')}` : '';
  if (result.service === 'pending') {
    return (
      `Revoked on your devices; finishing with qus.me… Until qus.me is told, ${name} may still ` +
      'look like it works in its client, though your devices refuse its drafts. qus.me will try ' +
      `again on the next sync, or press Retry.${refused}`
    );
  }
  return `${name} can no longer send drafts. Remove it from its client too.${refused}`;
}

const agentName = (agent: AgentRow) =>
  agent.label ?? agent.binding?.clientName ?? 'Unlabeled agent';

/**
 * One agent: its label, the client behind it, what it may do, and the revoke control; or, for a
 * revocation the service has not confirmed, that state and Retry.
 */
export function AgentItem(props: {
  agent: AgentRow;
  busy: boolean;
  onRevoke: (agent: AgentRow) => void;
  onRetry: (agent: AgentRow) => void;
  onEdit?: ((agent: AgentRow) => void) | undefined;
}) {
  const { agent } = props;
  const [confirming, setConfirming] = useState(false);
  if (agent.pendingRevocation !== undefined) {
    return (
      <li class="card-danger p-3">
        <p class="font-medium text-sm">{agentName(agent)}</p>
        {agent.binding !== undefined && (
          <p class="font-mono font-semibold text-xs">{agent.binding.clientHost}</p>
        )}
        <p class="text-danger text-sm" role="status">
          Revoked on your devices; finishing with qus.me…
        </p>
        <p class="text-muted text-xs">
          Until qus.me is told, the agent may still look like it works in its client, though your
          devices refuse its drafts. qus.me tries again on each sync.
        </p>
        {agent.pendingRevocation.lastError !== undefined && (
          <p class="text-muted text-xs">Last try: {agent.pendingRevocation.lastError}</p>
        )}
        <Button size="sm" class="mt-2" disabled={props.busy} onClick={() => props.onRetry(agent)}>
          Retry
        </Button>
      </li>
    );
  }
  return (
    <li class="card p-3">
      <p class="font-medium text-sm">{agentName(agent)}</p>
      {agent.binding !== undefined && (
        <p class="text-xs">
          <span class="font-mono font-semibold">{agent.binding.clientHost}</span>
          {agent.label !== undefined && agent.label !== agent.binding.clientName && (
            <span class="text-muted"> · calls itself {agent.binding.clientName}</span>
          )}
        </p>
      )}
      <p class="font-mono text-muted text-xs">{shortNpub(agent.agentPubkey)}</p>
      {agent.grant !== undefined && (
        <p class="text-muted text-xs">
          {agent.grant.destinations.length} destination
          {agent.grant.destinations.length === 1 ? '' : 's'}
          {agent.grant.allow_new_destinations && ', may propose new ones'}, up to{' '}
          {agent.grant.quota.max_submissions} {PERIOD_LABELS[agent.grant.quota.period]}
        </p>
      )}
      {agent.grant !== undefined && agent.counts !== undefined && (
        <p class="text-muted text-xs" data-agent-counts>
          {PERIOD_NOW[agent.grant.quota.period]}: {agent.counts.accepted} accepted
          {agent.counts.discarded > 0 && `, ${agent.counts.discarded} discarded`}
        </p>
      )}
      {!agent.listed && (
        <p class="text-danger text-xs">
          Not on the submitters list, so its drafts are already refused. The service still holds its
          key.
        </p>
      )}
      {confirming ? (
        <div class="mt-2 flex gap-2">
          <Button
            variant="danger"
            size="sm"
            disabled={props.busy}
            onClick={() => props.onRevoke(agent)}
          >
            Revoke now
          </Button>
          <Button variant="plain" size="sm" onClick={() => setConfirming(false)}>
            Keep
          </Button>
        </div>
      ) : (
        <div class="mt-2 flex gap-2">
          {agent.listed && agent.grant !== undefined && props.onEdit !== undefined && (
            <Button
              variant="plain"
              size="sm"
              disabled={props.busy}
              onClick={() => props.onEdit?.(agent)}
            >
              Edit access
            </Button>
          )}
          <Button
            variant="plain"
            size="sm"
            disabled={props.busy}
            onClick={() => setConfirming(true)}
          >
            Revoke…
          </Button>
        </div>
      )}
    </li>
  );
}

/**
 * A destination an agent proposed, with confirm, reject, and merge into one of the confirmed
 * destinations (the same account under another spelling, say).
 */
export function PendingItem(props: {
  destination: Destination;
  /** For the one destination format (drafts/row.ts); without it, the label alone. */
  source?: SiteDefinitionSource | undefined;
  /** Confirmed destinations it can merge into; none hides Merge. */
  confirmed?: Destination[];
  busy: boolean;
  onConfirm: (d: Destination) => void;
  onReject: (d: Destination) => void;
  onMerge?: ((d: Destination, into: Destination) => void) | undefined;
}) {
  const { destination } = props;
  const confirmed = props.confirmed ?? [];
  const [merging, setMerging] = useState<string | undefined>();
  const into = confirmed.find((d) => d.id === merging);
  const selectId = `merge-${destination.id}`;
  return (
    <li class="card p-3">
      <p class="text-sm">
        {props.source === undefined
          ? destination.label
          : destinationLabel(props.source, destination.site, destination.account, destination)}
      </p>
      <div class="mt-2 flex gap-2">
        <Button size="sm" disabled={props.busy} onClick={() => props.onConfirm(destination)}>
          Confirm
        </Button>
        <Button
          variant="danger"
          size="sm"
          disabled={props.busy}
          onClick={() => props.onReject(destination)}
        >
          Reject and dismiss its drafts
        </Button>
      </div>
      {props.onMerge !== undefined &&
        confirmed.length > 0 &&
        (merging === undefined ? (
          <button
            type="button"
            class="mt-2 text-xs link"
            disabled={props.busy}
            onClick={() => setMerging(confirmed[0]?.id)}
          >
            Merge into an existing account…
          </button>
        ) : (
          <div class="mt-2 card-band p-3">
            <label for={selectId} class="font-medium text-xs">
              Move its drafts to
            </label>
            <select
              id={selectId}
              class={`${inputClass} mt-1`}
              value={merging}
              onChange={(e) => setMerging(e.currentTarget.value)}
            >
              {confirmed.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label}
                </option>
              ))}
            </select>
            <p class="mt-1 text-muted text-xs">
              Its drafts become drafts for the destination you choose, and it leaves the list.
            </p>
            <div class="mt-2 flex gap-2">
              <Button
                size="sm"
                disabled={props.busy || into === undefined}
                onClick={() => into !== undefined && props.onMerge?.(destination, into)}
              >
                Merge
              </Button>
              <Button variant="plain" size="sm" onClick={() => setMerging(undefined)}>
                Cancel
              </Button>
            </div>
          </div>
        ))}
    </li>
  );
}

export function AgentsList(props: {
  view: AgentsView;
  busy: boolean;
  onRevoke: (agent: AgentRow) => void;
  onRetry: (agent: AgentRow) => void;
  onConfirm: (d: Destination) => void;
  onReject: (d: Destination) => void;
  onMerge?: (d: Destination, into: Destination) => void;
  onEdit?: (agent: AgentRow) => void;
  source?: SiteDefinitionSource | undefined;
}) {
  const { view } = props;
  return (
    <>
      {view.pending.length > 0 && (
        <section class="mt-3" aria-labelledby="pending-title">
          <h2 id="pending-title" class="font-semibold text-sm">
            Accounts waiting for your OK
          </h2>
          <ul class="mt-1 flex flex-col gap-2">
            {view.pending.map((d) => (
              <PendingItem
                key={d.id}
                destination={d}
                source={props.source}
                confirmed={view.confirmed}
                busy={props.busy}
                onConfirm={props.onConfirm}
                onReject={props.onReject}
                onMerge={props.onMerge}
              />
            ))}
          </ul>
        </section>
      )}
      <section class="mt-3" aria-labelledby="agents-title">
        <h2 id="agents-title" class="font-semibold text-sm">
          Authorized agents
        </h2>
        {view.agents.length === 0 ? (
          <p class="mt-1 text-sm">No agents are authorized.</p>
        ) : (
          <ul class="mt-1 flex flex-col gap-2">
            {view.agents.map((a) => (
              <AgentItem
                key={a.agentPubkey}
                agent={a}
                busy={props.busy}
                onRevoke={props.onRevoke}
                onRetry={props.onRetry}
                onEdit={props.onEdit}
              />
            ))}
          </ul>
        )}
        {view.bindingsError !== undefined && (
          <p class="mt-2 text-muted text-xs">
            The service's list is missing ({view.bindingsError}), so client names and hosts may be
            missing too.
          </p>
        )}
      </section>
    </>
  );
}

/** Editing an agent's access: the grant form, starting from its current grant (spec 7.4). */
export function EditGrantView(props: {
  agent: AgentRow;
  destinations: Destination[];
  start: GrantEditStart;
  choices: ApprovalChoices;
  busy: string | undefined;
  error: string | undefined;
  onChange: (choices: ApprovalChoices) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const { agent, choices } = props;
  const name = agentName(agent);
  const empty = sharesNothing(choices);
  return (
    <Screen title="Edit access" onBack={props.onCancel}>
      <p class="mt-2 font-medium text-sm">{name}</p>
      {agent.binding !== undefined && (
        <p class="font-mono font-semibold text-xs">{agent.binding.clientHost}</p>
      )}
      {props.start.dropped.length > 0 && (
        <p class="mt-2 text-muted text-xs" data-dropped>
          No longer among your destinations, so saving removes them from this agent:{' '}
          {props.start.dropped.map((d) => `${d.site} / ${d.account}`).join(', ')}.
        </p>
      )}
      <GrantForm destinations={props.destinations} choices={choices} onChange={props.onChange} />
      {empty && <NothingSharedWarning name={choices.label.trim() || name} />}
      <ErrorText message={props.error} />
      <div class="mt-4 flex gap-2">
        <Button onClick={props.onSave} disabled={props.busy !== undefined}>
          {props.busy ?? (empty ? 'Save anyway' : 'Save')}
        </Button>
        <Button variant="plain" onClick={props.onCancel} disabled={props.busy !== undefined}>
          Cancel
        </Button>
      </div>
    </Screen>
  );
}

/** The offer to share a destination just added or confirmed with agents (UX audit 3.2). */
export function ShareOfferView(props: {
  destination: Destination;
  candidates: AgentRow[];
  chosen: string[];
  busy: boolean;
  onToggle: (agentPubkey: string, on: boolean) => void;
  onShare: () => void;
  onSkip: () => void;
}) {
  if (props.candidates.length === 0) return null;
  return (
    <div class="mt-3 card-tint p-3" data-share-offer>
      <p class="font-medium text-sm">Share {props.destination.label} with</p>
      <ul class="mt-1 flex flex-col gap-1">
        {props.candidates.map((a) => (
          <li key={a.agentPubkey}>
            <label class="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={props.chosen.includes(a.agentPubkey)}
                onChange={(e) => props.onToggle(a.agentPubkey, e.currentTarget.checked)}
              />
              <span>{agentName(a)}</span>
            </label>
          </li>
        ))}
      </ul>
      <div class="mt-2 flex gap-2">
        <Button
          size="sm"
          disabled={props.busy || props.chosen.length === 0}
          onClick={props.onShare}
        >
          Share
        </Button>
        <Button variant="plain" size="sm" onClick={props.onSkip}>
          Not now
        </Button>
      </div>
    </div>
  );
}

/**
 * Offers to share `destination` with the agents that could use it, and republishes their grants
 * when the user picks some. Renders nothing when no agent could take it.
 */
export function ShareOffer(props: {
  deps: SetupDeps;
  destination: Destination;
  source?: SiteDefinitionSource | undefined;
  onDone: (message: string | undefined) => void;
}) {
  const { deps, destination, source } = props;
  const [candidates, setCandidates] = useState<AgentRow[]>([]);
  const [chosen, setChosen] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    let live = true;
    loadAgents(deps, { withService: false })
      .then((view) => {
        if (!live) return;
        const now = Math.floor(Date.now() / 1000);
        setCandidates(shareCandidates(view.agents, destination, now, source));
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [deps, destination, source]);
  const share = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const changed = await shareDestination(destination.id, chosen, deps, source);
      const names = candidates.filter((a) => changed.includes(a.agentPubkey)).map(agentName);
      props.onDone(
        names.length === 0 ? undefined : `Shared ${destination.label} with ${names.join(', ')}.`
      );
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <ShareOfferView
        destination={destination}
        candidates={candidates}
        chosen={chosen}
        busy={busy}
        onToggle={(pubkey, on) =>
          setChosen(on ? [...chosen, pubkey] : chosen.filter((p) => p !== pubkey))
        }
        onShare={() => void share()}
        onSkip={() => props.onDone(undefined)}
      />
      <ErrorText message={error} />
    </>
  );
}

/** The agents the queue authorizes and the destinations they proposed. */
export function AgentsScreen(props: {
  deps: SetupDeps;
  source?: SiteDefinitionSource | undefined;
  onBack: () => void;
  /** Opens the approval screen; approving an agent lives here, not on the home screen (H1). */
  onApprove?: () => void;
}) {
  const { deps, source } = props;
  const [view, setView] = useState<AgentsView | undefined>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<
    { agent: AgentRow; start: GrantEditStart; choices: ApprovalChoices } | undefined
  >();
  const [editBusy, setEditBusy] = useState<string>();
  const [editError, setEditError] = useState<string>();
  const [sharing, setSharing] = useState<Destination | undefined>();

  const load = useCallback(async () => {
    try {
      setView(await loadAgents(deps, { withService: true }));
    } catch (e) {
      setError(messageOf(e));
    }
  }, [deps]);
  useEffect(() => {
    void load();
  }, [load]);

  const run = async (action: () => Promise<string | undefined>) => {
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    setSharing(undefined);
    try {
      setNotice(await action());
      await load();
      void deps.requestSync?.().catch(() => undefined);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };

  const revoke = (agent: AgentRow) =>
    run(async () => {
      // Asked first, inside the click: Firefox grants the permission only during the gesture.
      const allowed = await deps.requestServicePermission();
      const result = await revokeAgent(agent.agentPubkey, deps, { serviceAllowed: allowed });
      return revokeMessage(agentName(agent), result);
    });
  const retry = (agent: AgentRow) =>
    run(async () => {
      if (!(await deps.requestServicePermission())) throw new SetupError(NO_SERVICE_PERMISSION);
      await finishRevocation(agent.agentPubkey, deps);
      return `${agentName(agent)} can no longer send drafts. Remove it from its client too.`;
    });
  const confirm = (d: Destination) =>
    run(async () => {
      await confirmPendingDestination(d.id, deps);
      setSharing({ ...d, status: 'confirmed' });
      return `Confirmed ${d.label}.`;
    });
  const reject = (d: Destination) =>
    run(async () => {
      const { dismissed } = await rejectPendingDestination(d.id, deps, source);
      return `Removed ${d.label} and dismissed ${dismissed} draft${dismissed === 1 ? '' : 's'}.`;
    });
  const merge = (d: Destination, into: Destination) =>
    run(async () => {
      const { moved } = await mergePendingDestination(d.id, into.id, deps, source);
      return `Merged ${d.label} into ${into.label} and moved ${moved} draft${moved === 1 ? '' : 's'}.`;
    });
  const edit = (agent: AgentRow) => {
    if (agent.grant === undefined || view === undefined) return;
    const start = choicesFromGrant(
      agent.label ?? agent.binding?.clientName ?? '',
      agent.grant,
      view.confirmed,
      source
    );
    setNotice(undefined);
    setError(undefined);
    setEditError(undefined);
    setSharing(undefined);
    setEditing({ agent, start, choices: start.choices });
  };
  const save = async () => {
    if (editing === undefined) return;
    setEditBusy('Saving…');
    setEditError(undefined);
    try {
      await editGrant(editing.agent.agentPubkey, editing.choices, deps);
      setEditing(undefined);
      setNotice(`Saved ${editing.choices.label.trim()}'s access.`);
      await load();
    } catch (e) {
      setEditError(messageOf(e));
    } finally {
      setEditBusy(undefined);
    }
  };

  if (editing !== undefined && view !== undefined) {
    return (
      <EditGrantView
        agent={editing.agent}
        destinations={view.confirmed}
        start={editing.start}
        choices={editing.choices}
        busy={editBusy}
        error={editError}
        onChange={(choices) => setEditing({ ...editing, choices })}
        onSave={() => void save()}
        onCancel={() => setEditing(undefined)}
      />
    );
  }

  return (
    <Screen title="Agents" onBack={props.onBack}>
      {props.onApprove !== undefined && (
        <Button class="mt-3 self-start" onClick={props.onApprove}>
          Approve an agent
        </Button>
      )}
      {view === undefined && error === undefined && <p class="mt-2 text-sm">Loading…</p>}
      {view !== undefined && (
        <AgentsList
          view={view}
          source={source}
          busy={busy}
          onRevoke={revoke}
          onRetry={retry}
          onConfirm={confirm}
          onReject={reject}
          onMerge={merge}
          onEdit={edit}
        />
      )}
      {notice !== undefined && (
        <p role="status" class="mt-3 text-sm">
          {notice}
        </p>
      )}
      {sharing !== undefined && (
        <ShareOffer
          deps={deps}
          destination={sharing}
          source={source}
          onDone={(message) => {
            setSharing(undefined);
            if (message !== undefined) {
              setNotice(message);
              void load();
            }
          }}
        />
      )}
      <ErrorText message={error} />
    </Screen>
  );
}

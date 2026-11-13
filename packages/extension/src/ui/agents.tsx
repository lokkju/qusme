/**
 * Agent approval, the agents list and pending destinations (spec 8.2, 11.8). Client names, URLs,
 * agent labels and destination labels come from MCP clients, agents and relays, so every one is a
 * JSX text child, which Preact sets as text. The client ID's host is shown large next to the name,
 * since any client can call itself anything but cannot serve its document from another's host.
 */
import type { Destination, QuotaPeriod } from '@qusme/nostr';
import { createLocalSigner, MAX_SUBMISSION_EXPIRATION_DAYS, QUOTA_PERIODS } from '@qusme/nostr';
import { npubEncode } from 'nostr-tools/nip19';
import type { ComponentChildren } from 'preact';
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
import {
  approveLocalAgent,
  denyLocalAgent,
  findLocalRequest,
  isLocalRequest,
  type LocalAgentRequest,
  LocalRequestRefused,
  localServerCommand,
} from '../agents/localRequest.ts';
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
import { effectiveDefinition, type SiteDefinitionSource } from '../insertion/definitions.ts';
import { type SetupDeps, SetupError } from '../setup/deps.ts';
import { messageOf } from './app.tsx';
import {
  BottomBar,
  Button,
  CopyButton,
  ErrorText,
  Field,
  groupLabel,
  inputClass,
  Screen,
} from './components.tsx';

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
 * can't serve its document from another's host. The rest of the request, and whatever the caller
 * puts in `children` (the label), is under Details (critique A4).
 */
export function RequestSummary(props: {
  request: AuthorizationRequest | LocalAgentRequest;
  /** The code came off the sign-in page in this tab rather than being typed (critique A1). */
  fromTab?: boolean;
  children?: ComponentChildren;
}) {
  const { request } = props;
  if (isLocalRequest(request)) {
    return <LocalRequestSummary request={request}>{props.children}</LocalRequestSummary>;
  }
  return (
    <div class="mt-3 card-band p-3">
      <p class="text-muted text-xs">
        Code {request.code}
        {props.fromTab && ', read from this tab'} · calls itself
      </p>
      <p class="font-semibold text-lg break-words">{request.clientName}</p>
      <p class="mt-1 text-muted text-xs">from</p>
      <p class="font-mono font-bold text-2xl break-all" data-client-host>
        {request.clientHost}
      </p>
      <p class="mt-1 text-xs">
        Only approve if you just connected an agent from {request.clientHost}.
      </p>
      <details class="mt-2 text-xs">
        <summary class="cursor-pointer text-muted">Details</summary>
        {props.children}
        <dl class="mt-2 grid grid-cols-[auto_1fr] gap-x-2 gap-y-1">
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

/**
 * A local MCP server's request (spec 8.6): no client document and no host to show, so the agent
 * key is what the user compares, large, with the one the server printed or answered with.
 */
function LocalRequestSummary(props: { request: LocalAgentRequest; children?: ComponentChildren }) {
  const { request } = props;
  return (
    <div class="mt-3 card-band p-3" data-local-request>
      <p class="text-muted text-xs">Code {request.code} · calls itself</p>
      <p class="font-semibold text-lg break-words">{request.clientName}</p>
      <p class="mt-1 text-muted text-xs">a qus.me MCP server on your computer, with agent key</p>
      <p class="font-mono font-bold text-lg break-all" data-agent-key>
        {shortNpub(request.agentPubkey)}
      </p>
      <p class="mt-1 text-xs">
        Only approve if you just started qus.me's MCP server and it shows this code and key.
      </p>
      <details class="mt-2 text-xs">
        <summary class="cursor-pointer text-muted">Details</summary>
        {props.children}
        <dl class="mt-2 grid grid-cols-[auto_1fr] gap-x-2 gap-y-1">
          <dt class="text-muted">Agent key</dt>
          <dd class="break-all font-mono">{npubEncode(request.agentPubkey)}</dd>
        </dl>
      </details>
    </div>
  );
}

/** The agent's label, private to the queue; it sits under Details on both forms (critique A3). */
export function LabelField(props: {
  choices: ApprovalChoices;
  onChange: (choices: ApprovalChoices) => void;
}) {
  return (
    <Field id="agent-label" label="Label" hint="Only your devices see it.">
      <input
        id="agent-label"
        class={inputClass}
        value={props.choices.label}
        maxLength={100}
        aria-describedby="agent-label-hint"
        onInput={(e) => props.onChange({ ...props.choices, label: e.currentTarget.value })}
      />
    </Field>
  );
}

/** Above Approve when the agent would be able to draft nothing (UX audit 4.7). */
export function NothingSharedWarning(props: { name: string }) {
  return (
    <div role="alert" class="mt-3 card-danger p-3">
      <p class="font-semibold text-sm">This agent won't be able to draft anything</p>
      <p class="mt-1 text-xs">
        Nothing is shared with {props.name} and it can't add new accounts, so every draft it sends
        will be refused. Tick an account or let it add new ones; otherwise you'd have to revoke it
        and approve it again to share one later.
      </p>
    </div>
  );
}

/** The review step: who is asking, the grant form, the warning and the pinned buttons. */
export function ApprovalReview(props: {
  request: AuthorizationRequest | LocalAgentRequest;
  destinations: Destination[];
  choices: ApprovalChoices;
  busy: string | undefined;
  error: string | undefined;
  fromTab?: boolean;
  source?: SiteDefinitionSource | undefined;
  onChange: (choices: ApprovalChoices) => void;
  onApprove: () => void;
  onDeny: () => void;
  onBack: () => void;
}) {
  const { choices } = props;
  const empty = sharesNothing(choices);
  return (
    <Screen title="Approve an agent" onBack={props.onBack}>
      <RequestSummary request={props.request} fromTab={props.fromTab ?? false}>
        <LabelField choices={choices} onChange={props.onChange} />
      </RequestSummary>
      <GrantForm
        destinations={props.destinations}
        choices={choices}
        source={props.source}
        onChange={props.onChange}
      />
      {empty && <NothingSharedWarning name={choices.label.trim() || props.request.clientName} />}
      <BottomBar>
        <ErrorText message={props.error} class="mb-2" />
        <div class="flex gap-2">
          <Button onClick={props.onApprove} disabled={props.busy !== undefined}>
            {props.busy ?? (empty ? 'Approve anyway' : 'Approve')}
          </Button>
          <Button variant="danger" onClick={props.onDeny} disabled={props.busy !== undefined}>
            Deny
          </Button>
        </div>
      </BottomBar>
    </Screen>
  );
}

/** After an approval: the steps that finished, and what to ask the agent next (critique A5). */
export function ApprovalDone(props: {
  name: string;
  shared: string[];
  /** A local MCP server: told through the inbox relay, with no service to confirm (8.6). */
  local?: boolean;
  onDone: () => void;
}) {
  const tick = (
    <span
      aria-hidden="true"
      class="flex h-5 w-5 flex-none items-center justify-center rounded-full bg-accent text-on-accent text-xs"
    >
      ✓
    </span>
  );
  const first = props.shared[0];
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
            <span>
              {props.local
                ? 'Told the MCP server on your computer'
                : 'qus.me confirmed the approval'}
            </span>
          </li>
          <li class="flex items-center gap-2">
            {/* The extension can't see the client's tab; its authorize page redirects on its own. */}
            <span
              aria-hidden="true"
              class="flex h-5 w-5 flex-none items-center justify-center rounded-full border border-accent text-accent text-xs"
            >
              →
            </span>
            <span>
              {props.local
                ? `${props.name} picks it up on its next call`
                : `${props.name} finishes signing in on its own: go back to its page`}
            </span>
          </li>
        </ol>
      </div>
      <p class="mt-3 text-muted text-xs">
        {props.shared.length === 0 ? 'Shared: nothing yet.' : `Shared: ${props.shared.join(', ')}.`}
      </p>
      <p class="mt-3 card-tint p-3 text-sm" data-next-step>
        {first === undefined
          ? `Now ask ${props.name} to draft something.`
          : `Now ask ${props.name} to draft something: "Draft a post for ${first} about …"`}
      </p>
      <Button class="mt-4" onClick={props.onDone}>
        Back to drafts
      </Button>
    </Screen>
  );
}

const PERIOD_UNIT: Record<QuotaPeriod, string> = { day: 'day', week: 'week', month: 'month' };

/**
 * The limits in one line, for the collapsed Limits row (critique A3): "50 drafts a day · unread
 * drafts expire after 30 days · no end date".
 */
export function limitsSummary(choices: ApprovalChoices): string {
  const { max_submissions: max, period } = choices.quota;
  const days = choices.submissionExpirationDays;
  return [
    `${max} draft${max === 1 ? '' : 's'} a ${PERIOD_UNIT[period]}`,
    `unread drafts expire after ${days} day${days === 1 ? '' : 's'}`,
    choices.expiresAt === null ? 'no end date' : `access ends ${dateOf(choices.expiresAt)}`,
  ].join(' · ');
}

/** The fields a destination's definition offers; one or none means there is nothing to choose. */
function fieldsOf(
  source: SiteDefinitionSource | undefined,
  destination: Destination
): { name: string; label: string }[] {
  if (source === undefined) return [];
  return effectiveDefinition(source, destination.site, destination.override)?.fields ?? [];
}

/**
 * The grant form: the accounts as a checkbox list in the one account format, the new-accounts
 * toggle, and the limits folded into one line with Change. Fields are chosen only where the site
 * definition has more than one (critique A2); the label is the caller's, under Details.
 */
export function GrantForm(props: {
  destinations: Destination[];
  choices: ApprovalChoices;
  source?: SiteDefinitionSource | undefined;
  onChange: (choices: ApprovalChoices) => void;
}) {
  const { destinations, choices, onChange, source } = props;
  const [limitsOpen, setLimitsOpen] = useState(false);
  const set = (patch: Partial<ApprovalChoices>) => onChange({ ...choices, ...patch });
  const chosen = (id: string) => choices.destinations.find((d) => d.id === id);
  const toggle = (id: string, on: boolean) =>
    set({
      destinations: on
        ? [...choices.destinations, { id, fields: [...DEFAULT_FIELDS] }]
        : choices.destinations.filter((d) => d.id !== id),
    });
  const toggleField = (id: string, field: string, on: boolean) =>
    set({
      destinations: choices.destinations.map((d) =>
        d.id === id
          ? {
              ...d,
              fields: on ? [...d.fields, field] : d.fields.filter((f) => f !== field),
            }
          : d
      ),
    });
  const labelOf = (d: Destination) =>
    source === undefined ? d.label : destinationLabel(source, d.site, d.account, d);
  return (
    <>
      <fieldset class="mt-3">
        <legend class={groupLabel}>Where it may draft</legend>
        {destinations.length === 0 ? (
          <p class="text-muted text-xs">
            You have no accounts yet. Without any, it can draft only if you let it add new accounts
            below.
          </p>
        ) : (
          <ul class="-mx-4 border-line border-t">
            {destinations.map((d) => {
              const choice = chosen(d.id);
              const label = labelOf(d);
              const fields = fieldsOf(source, d);
              return (
                <li key={d.id} class="border-line border-b px-4 py-1.5">
                  <label class="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={choice !== undefined}
                      onChange={(e) => toggle(d.id, e.currentTarget.checked)}
                    />
                    <span class="break-words">{label}</span>
                  </label>
                  {choice !== undefined && fields.length > 1 && (
                    <fieldset class="mt-1 ml-6 flex flex-wrap gap-x-3 gap-y-1 text-xs">
                      <legend class="sr-only">Fields for {label}</legend>
                      {fields.map((f) => (
                        <label key={f.name} class="flex items-center gap-1">
                          <input
                            type="checkbox"
                            checked={choice.fields.includes(f.name)}
                            onChange={(e) => toggleField(d.id, f.name, e.currentTarget.checked)}
                          />
                          <span>{f.label}</span>
                        </label>
                      ))}
                    </fieldset>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </fieldset>

      <div class="-mx-4 flex items-start gap-2 border-line border-b px-4 py-1.5">
        <input
          id="allow-new-destinations"
          type="checkbox"
          class="mt-1"
          checked={choices.allowNewDestinations}
          aria-describedby="allow-new-destinations-hint"
          onChange={(e) => set({ allowNewDestinations: e.currentTarget.checked })}
        />
        <div>
          <label for="allow-new-destinations" class="text-sm">
            Let it add new accounts
          </label>
          <p id="allow-new-destinations-hint" class="text-muted text-xs">
            Each one waits for your OK before its drafts show.
          </p>
        </div>
      </div>

      <div class="mt-2 card-band px-3 py-2" data-limits>
        <div class="flex items-start gap-3">
          <p class="flex-1 text-xs" id="limits-summary">
            <span class="font-semibold">Limits:</span> {limitsSummary(choices)}
          </p>
          <button
            type="button"
            class="text-xs link"
            aria-expanded={limitsOpen}
            aria-controls="limits-fields"
            aria-label={limitsOpen ? 'Hide limits' : 'Change limits'}
            onClick={() => setLimitsOpen(!limitsOpen)}
          >
            {limitsOpen ? 'Hide' : 'Change'}
          </button>
        </div>
        {limitsOpen && (
          <div id="limits-fields" class="pb-1">
            <div class="grid grid-cols-2 gap-3">
              <Field id="quota-max" label="Quota">
                <input
                  id="quota-max"
                  type="number"
                  min={1}
                  class={inputClass}
                  value={String(choices.quota.max_submissions)}
                  onInput={(e) =>
                    set({
                      quota: { ...choices.quota, max_submissions: Number(e.currentTarget.value) },
                    })
                  }
                />
              </Field>
              <Field id="quota-period" label="Period">
                <select
                  id="quota-period"
                  class={inputClass}
                  value={choices.quota.period}
                  onChange={(e) =>
                    set({
                      quota: { ...choices.quota, period: e.currentTarget.value as QuotaPeriod },
                    })
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
              label="Unread drafts expire after (days)"
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
          </div>
        )}
      </div>
    </>
  );
}

type PendingRequest = AuthorizationRequest | LocalAgentRequest;

type ApprovePhase =
  | { phase: 'code' }
  | { phase: 'review'; request: PendingRequest; destinations: Destination[] }
  | { phase: 'done'; approved: true; name: string; shared: string[]; local: boolean }
  | { phase: 'done'; approved: false; local: boolean };

/**
 * How to start qus.me's MCP server on this computer for this queue (spec 8.6), on the code step:
 * the command carries the Queue ID with the inbox relay, so the server needs nothing else.
 */
function LocalServerHint(props: { deps: SetupDeps }) {
  const [command, setCommand] = useState<string>();
  useEffect(() => {
    let live = true;
    localServerCommand(props.deps.store)
      .then((c) => {
        if (live) setCommand(c);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  if (command === undefined) return null;
  return (
    <details class="mt-4 text-xs" data-local-hint>
      <summary class="cursor-pointer text-muted">
        Running qus.me's MCP server on your computer?
      </summary>
      <p class="mt-1">
        Start it with this command (or put it in your MCP client's settings). It shows a code to
        enter here.
      </p>
      <p class="mt-1 break-all font-mono">{command}</p>
      <CopyButton text={command} size="xs" />
    </details>
  );
}

/**
 * Enter the code from the client's authorize page, or from qus.me's MCP server on this computer,
 * review the request, approve or deny. Both codes look alike, so a typed code is looked for first
 * among the queue's inbox events (a local server's request, spec 7.7), which needs no permission;
 * when no local request has it, the code goes to app.qus.me, at once when the service permission
 * is already granted and otherwise after the user's click on "Look up at app.qus.me", since a
 * permission request needs a click of its own. With a code read off the sign-in tab (`fromTab`) the
 * code is a hosted one: the screen asks the service directly, on open when the permission is
 * granted (critique A1).
 */
export function ApproveAgentScreen(props: {
  deps: SetupDeps;
  initialCode?: string;
  fromTab?: boolean;
  source?: SiteDefinitionSource | undefined;
  onDone: () => void;
  onBack: () => void;
}) {
  const { deps, source } = props;
  const [input, setInput] = useState(props.initialCode ?? '');
  const [phase, setPhase] = useState<ApprovePhase>({ phase: 'code' });
  const [choices, setChoices] = useState<ApprovalChoices | undefined>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  /** A code no local request had, waiting for the user's click to ask app.qus.me. */
  const [serviceCode, setServiceCode] = useState<string>();

  const review = (request: PendingRequest, destinations: Destination[]) => {
    setChoices(defaultChoices(request, destinations));
    setPhase({ phase: 'review', request, destinations });
  };

  /** `gesture`: called from the user's click, so the permission may be requested. */
  const lookUpService = async (code: string, gesture: boolean) => {
    setError(undefined);
    setServiceCode(undefined);
    setBusy('Looking up…');
    try {
      // First thing awaited in the gesture: Firefox grants the permission only inside it.
      const allowed = gesture
        ? await deps.requestServicePermission()
        : ((await deps.hasServicePermission?.()) ?? false);
      if (!allowed) {
        throw new SetupError(
          'Allow qus.me to reach app.qus.me when the browser asks; that is where it looks up the code.'
        );
      }
      const unlocked = await deps.store.unlocked();
      if (unlocked === undefined) throw new SetupError('Unlock the queue first.');
      const [request, destinations] = await Promise.all([
        fetchAuthorization(createLocalSigner(unlocked.queueKey), code, deps),
        loadShareableDestinations(deps),
      ]);
      review(request, destinations);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(undefined);
    }
  };

  const lookUp = async (text: string) => {
    setError(undefined);
    setServiceCode(undefined);
    const code = parseApprovalCode(text, deps.serviceOrigin);
    if (code === undefined) {
      setError('Enter the 8-character code from the page, like ABCD-1234, or paste its link.');
      return;
    }
    // A pasted approve link is the service's own page: no local server makes one.
    const isLink = /^[a-z][a-z0-9+.-]*:/i.test(text.trim());
    if (!isLink) {
      setBusy('Looking up…');
      try {
        const [request, destinations] = await Promise.all([
          findLocalRequest(code, deps),
          loadShareableDestinations(deps),
        ]);
        review(request, destinations);
        setBusy(undefined);
        return;
      } catch (e) {
        if (e instanceof LocalRequestRefused) {
          setError(e.message);
          setBusy(undefined);
          return;
        }
        // No local request with that code (or the inbox relay is out of reach): app.qus.me's.
      }
      setBusy(undefined);
      if (!((await deps.hasServicePermission?.()) ?? false)) {
        setServiceCode(code);
        setError(
          'No MCP server on your computer sent that code. If it came from an AI app’s sign-in page, look it up at app.qus.me.'
        );
        return;
      }
    }
    await lookUpService(code, isLink);
  };

  // Once, on open: a code read off the sign-in tab goes straight to the review when it can.
  useEffect(() => {
    const code = props.initialCode;
    if (!props.fromTab || code === undefined) return;
    let live = true;
    void (async () => {
      if (!((await deps.hasServicePermission?.()) ?? false) || !live) return;
      const parsed = parseApprovalCode(code, deps.serviceOrigin);
      if (parsed !== undefined) await lookUpService(parsed, false);
    })();
    return () => {
      live = false;
    };
  }, []);

  if (phase.phase === 'code') {
    const submit = (event: Event) => {
      event.preventDefault();
      if (props.fromTab) {
        const code = parseApprovalCode(input, deps.serviceOrigin);
        if (code === undefined) {
          setError('Enter the 8-character code from the page, like ABCD-1234, or paste its link.');
          return;
        }
        void lookUpService(code, true);
        return;
      }
      void lookUp(input);
    };
    return (
      <Screen title="Approve an agent" onBack={props.onBack}>
        <p class="mt-2 text-sm">
          {props.fromTab
            ? 'This is the code on the sign-in page in this tab.'
            : "Enter the code your AI app's sign-in page or qus.me's MCP server shows, or paste the link from its QR code."}
        </p>
        <form onSubmit={submit}>
          <Field id="approval-code" label="Code or link">
            <input
              id="approval-code"
              class={`${inputClass} font-mono`}
              autocomplete="off"
              spellcheck={false}
              placeholder="ABCD-1234"
              value={input}
              onInput={(e) => {
                setInput(e.currentTarget.value);
                setServiceCode(undefined);
              }}
            />
          </Field>
          <ErrorText message={error} />
          {serviceCode !== undefined ? (
            <Button
              class="mt-3"
              disabled={busy !== undefined}
              onClick={() => void lookUpService(serviceCode, true)}
            >
              {busy ?? 'Look up at app.qus.me'}
            </Button>
          ) : (
            <Button type="submit" class="mt-3" disabled={busy !== undefined || input.trim() === ''}>
              {busy ?? 'Look up'}
            </Button>
          )}
        </form>
        {!props.fromTab && <LocalServerHint deps={deps} />}
      </Screen>
    );
  }

  if (phase.phase === 'done') {
    if (phase.approved)
      return (
        <ApprovalDone
          name={phase.name}
          shared={phase.shared}
          local={phase.local}
          onDone={props.onDone}
        />
      );
    return (
      <Screen title="Request denied">
        <p class="mt-2 text-sm" role="status">
          {phase.local
            ? 'The MCP server on your computer was told no. It is not connected.'
            : 'qus.me discarded the key it made for this request. The agent is not connected.'}
        </p>
        <Button class="mt-4" onClick={props.onDone}>
          Done
        </Button>
      </Screen>
    );
  }

  const { request, destinations } = phase;
  const local = isLocalRequest(request);
  const approve = async () => {
    if (choices === undefined) return;
    setError(undefined);
    setBusy('Publishing…');
    try {
      if (isLocalRequest(request)) await approveLocalAgent(request, choices, deps);
      else await approveAgent(request, choices, deps);
      const shared = choices.destinations.flatMap((c) => {
        const d = destinations.find((x) => x.id === c.id);
        if (d === undefined) return [];
        return source === undefined ? d.label : destinationLabel(source, d.site, d.account, d);
      });
      setPhase({
        phase: 'done',
        approved: true,
        name: choices.label.trim() || request.clientName,
        shared,
        local,
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
      if (isLocalRequest(request)) await denyLocalAgent(request, deps);
      else await denyAgent(request, deps);
      setPhase({ phase: 'done', approved: false, local });
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
      fromTab={props.fromTab ?? false}
      source={source}
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
    result.refusals.length > 0
      ? ` Some storage servers refused: ${result.refusals.join('; ')}`
      : '';
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

/** "3 accounts, may add new ones · up to 50 a day", for an agent's row. */
function grantSummary(grant: NonNullable<AgentRow['grant']>): string {
  const n = grant.destinations.length;
  const accounts = `${n} account${n === 1 ? '' : 's'}${grant.allow_new_destinations ? ', may add new ones' : ''}`;
  return `${accounts} · up to ${grant.quota.max_submissions} ${PERIOD_LABELS[grant.quota.period]}`;
}

/**
 * One agent as a hairline row: its label, the client behind it, what it may do, and Edit access
 * and Revoke; or, for a revocation the service has not confirmed, that state and Retry. No key:
 * the npub helps nobody here (critique A6).
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
      <li class="border-line border-b bg-danger-tint px-4 py-2.5">
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
    <li class="border-line border-b px-4 py-2.5">
      <p class="text-sm">
        <span class="font-medium">{agentName(agent)}</span>
        {agent.local === true && agent.binding === undefined && (
          <span class="text-muted text-xs"> · on your computer</span>
        )}
        {agent.binding !== undefined && (
          <span class="text-muted text-xs">
            {' · '}
            <span class="font-mono font-semibold text-ink">{agent.binding.clientHost}</span>
            {agent.label !== undefined &&
              agent.label !== agent.binding.clientName &&
              ` · calls itself ${agent.binding.clientName}`}
          </span>
        )}
      </p>
      {agent.grant !== undefined && (
        <p class="text-muted text-xs">
          {grantSummary(agent.grant)}
          {agent.counts !== undefined && (
            <span data-agent-counts>
              {' · '}
              {PERIOD_NOW[agent.grant.quota.period]}: {agent.counts.accepted} accepted
              {agent.counts.discarded > 0 && `, ${agent.counts.discarded} discarded`}
            </span>
          )}
        </p>
      )}
      {!agent.listed && (
        <p class="text-danger text-xs">
          Your devices already refuse its drafts, but qus.me still holds its key. Revoke it to
          finish.
        </p>
      )}
      {confirming ? (
        <div class="mt-1.5">
          <p class="text-xs">{agentName(agent)} will no longer be able to send drafts.</p>
          <div class="mt-1 flex gap-2">
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
        </div>
      ) : (
        <div class="mt-1.5 flex gap-2">
          {agent.listed && agent.grant !== undefined && props.onEdit !== undefined && (
            <Button
              variant="plain"
              size="xs"
              disabled={props.busy}
              onClick={() => props.onEdit?.(agent)}
            >
              Edit access
            </Button>
          )}
          <Button
            variant="plain"
            size="xs"
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
 * An account an agent proposed, as a hairline row with Allow and Reject, the same pair as the
 * home list's card (critique A7, A8), and merging into a confirmed account (the same account under
 * another spelling, say). Reject asks first and names what it does to the drafts.
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
  const [rejecting, setRejecting] = useState(false);
  const into = confirmed.find((d) => d.id === merging);
  const selectId = `merge-${destination.id}`;
  const label = (d: Destination) =>
    props.source === undefined ? d.label : destinationLabel(props.source, d.site, d.account, d);
  return (
    <li class="border-line border-b px-4 py-2.5">
      <p class="text-sm">{label(destination)}</p>
      {rejecting ? (
        <div class="mt-1.5">
          <p class="text-xs">Rejecting also dismisses its drafts.</p>
          <div class="mt-1 flex gap-2">
            <Button
              variant="danger"
              size="sm"
              disabled={props.busy}
              onClick={() => props.onReject(destination)}
            >
              Reject
            </Button>
            <Button variant="plain" size="sm" onClick={() => setRejecting(false)}>
              Keep
            </Button>
          </div>
        </div>
      ) : (
        <div class="mt-1.5 flex gap-2">
          <Button size="sm" disabled={props.busy} onClick={() => props.onConfirm(destination)}>
            Allow
          </Button>
          <Button
            variant="plain"
            size="sm"
            disabled={props.busy}
            onClick={() => setRejecting(true)}
          >
            Reject…
          </Button>
        </div>
      )}
      {props.onMerge !== undefined &&
        confirmed.length > 0 &&
        (merging === undefined ? (
          <button
            type="button"
            class="mt-1.5 text-xs link"
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
                  {label(d)}
                </option>
              ))}
            </select>
            <p class="mt-1 text-muted text-xs">
              Its drafts become drafts for the account you choose, and it leaves the list.
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
        <section aria-labelledby="pending-title">
          <h2 id="pending-title" class={groupLabel}>
            Accounts waiting for your OK
          </h2>
          <ul class="-mx-4 border-line border-t">
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
      <section aria-labelledby="agents-title">
        <h2 id="agents-title" class={groupLabel}>
          Connected agents
        </h2>
        {view.agents.length === 0 ? (
          <p class="text-sm">
            No agents connected yet. Connect one in your AI app, then approve its code here.
          </p>
        ) : (
          <ul class="-mx-4 border-line border-t">
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
            Couldn't get the agent list from qus.me ({view.bindingsError}), so some names and hosts
            may be missing.
          </p>
        )}
      </section>
    </>
  );
}

/**
 * Editing an agent's access (spec 7.4): the approval's compact form, starting from its current
 * grant, with the label under Details and Save and Cancel pinned to the bottom.
 */
export function EditGrantView(props: {
  agent: AgentRow;
  destinations: Destination[];
  start: GrantEditStart;
  choices: ApprovalChoices;
  busy: string | undefined;
  error: string | undefined;
  source?: SiteDefinitionSource | undefined;
  onChange: (choices: ApprovalChoices) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const { agent, choices } = props;
  const name = agentName(agent);
  const empty = sharesNothing(choices);
  return (
    <Screen title="Edit access" onBack={props.onCancel}>
      <div class="mt-3 card-band p-3">
        <p class="font-semibold text-base">{name}</p>
        {agent.binding !== undefined && (
          <p class="font-mono font-semibold text-sm">{agent.binding.clientHost}</p>
        )}
        <details class="mt-2 text-xs">
          <summary class="cursor-pointer text-muted">Details</summary>
          <LabelField choices={choices} onChange={props.onChange} />
          {agent.binding !== undefined && (
            <dl class="mt-2 grid grid-cols-[auto_1fr] gap-x-2 gap-y-1">
              <dt class="text-muted">Client ID</dt>
              <dd class="break-all font-mono">{agent.binding.clientId}</dd>
            </dl>
          )}
        </details>
      </div>
      {props.start.dropped.length > 0 && (
        <p class="mt-2 text-muted text-xs" data-dropped>
          No longer among your accounts, so saving removes them from this agent:{' '}
          {props.start.dropped.map((d) => `${d.site} / ${d.account}`).join(', ')}.
        </p>
      )}
      <GrantForm
        destinations={props.destinations}
        choices={choices}
        source={props.source}
        onChange={props.onChange}
      />
      {empty && <NothingSharedWarning name={choices.label.trim() || name} />}
      <BottomBar>
        <ErrorText message={props.error} class="mb-2" />
        <div class="flex gap-2">
          <Button onClick={props.onSave} disabled={props.busy !== undefined}>
            {props.busy ?? (empty ? 'Save anyway' : 'Save')}
          </Button>
          <Button variant="plain" onClick={props.onCancel} disabled={props.busy !== undefined}>
            Cancel
          </Button>
        </div>
      </BottomBar>
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
      // Asked first, inside the click: Firefox grants the permission only during the gesture. A
      // local MCP server has nothing at the service, so it needs none.
      const allowed = agent.local === true ? true : await deps.requestServicePermission();
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
        source={source}
        onChange={(choices) => setEditing({ ...editing, choices })}
        onSave={() => void save()}
        onCancel={() => setEditing(undefined)}
      />
    );
  }

  return (
    <Screen title="Agents" onBack={props.onBack}>
      {props.onApprove !== undefined && (
        <Button size="sm" class="mt-3 self-start" onClick={props.onApprove}>
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

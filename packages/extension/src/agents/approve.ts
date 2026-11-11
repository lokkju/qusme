/**
 * Approving or denying an MCP client's authorization on this device (spec 8.2 steps 3 and 4,
 * 11.8). Approval publishes the submitters list naming the agent and the agent's grant to every
 * storage relay, and only then posts the approval naming those relays, since the service approves
 * only once it reads a submitters list signed by the queue key that names the agent (step 5).
 */
import { hexToBytes } from '@noble/hashes/utils.js';
import {
  type AgentGrantInput,
  buildAgentGrant,
  buildSubmittersList,
  createLocalSigner,
  DEFAULT_SUBMISSION_EXPIRATION_DAYS,
  type Destination,
  type GrantDestination,
  MAX_SUBMISSION_EXPIRATION_DAYS,
  type QuotaPeriod,
  type Settings,
  type SubmitterLabel,
} from '@qusme/nostr';
import { getPublicKey } from 'nostr-tools/pure';
import { SetupError } from '../setup/deps.ts';
import {
  type AgentDeps,
  after,
  LOCKED_MESSAGE,
  publishOrThrow,
  readQueue,
  withQueue,
} from './queue.ts';
import { type AuthorizationRequest, postApproval, postDenial } from './service.ts';

/** Waits before each approval retry: about 7.5 s in all for the relays to serve the new list. */
export const APPROVAL_RETRY_MS: readonly number[] = [500, 1000, 2000, 4000];

/** The quota the approval screen starts from, as in the spec 7.4 example. */
export const DEFAULT_QUOTA: { max_submissions: number; period: QuotaPeriod } = {
  max_submissions: 50,
  period: 'day',
};

/** The field the approval screen offers for a destination before the user edits it. */
export const DEFAULT_FIELDS = ['text'];

export interface DestinationChoice {
  /** A confirmed destination's id (7.2). */
  id: string;
  /** The fields the agent may draft for there. */
  fields: string[];
}

/** What the user chose on the approval screen. */
export interface ApprovalChoices {
  /** The agent's label in the submitters list, private to the queue (7.3). */
  label: string;
  destinations: DestinationChoice[];
  /** Off unless the user turns it on (spec 7.4, decided in lokkju/qusme#28). */
  allowNewDestinations: boolean;
  quota: { max_submissions: number; period: QuotaPeriod };
  submissionExpirationDays: number;
  /** Unix seconds, or null for a grant that does not expire. */
  expiresAt: number | null;
}

/**
 * Where the approval screen starts: every confirmed destination shared with the default field
 * (operator decision 2026-11-06; UX audit 4.8), new destinations off.
 */
export function defaultChoices(
  request: AuthorizationRequest,
  destinations: readonly Destination[] = []
): ApprovalChoices {
  return {
    label: request.clientName,
    destinations: destinations
      .filter((d) => d.status === 'confirmed')
      .map((d) => ({ id: d.id, fields: [...DEFAULT_FIELDS] })),
    allowNewDestinations: false,
    quota: { ...DEFAULT_QUOTA },
    submissionExpirationDays: DEFAULT_SUBMISSION_EXPIRATION_DAYS,
    expiresAt: null,
  };
}

/** True when the choices share no destination and refuse new ones: the agent can draft nothing. */
export function sharesNothing(choices: ApprovalChoices): boolean {
  return choices.destinations.length === 0 && !choices.allowNewDestinations;
}

/**
 * The grant for the choices (spec 7.4), from the queue's destinations and settings. Each shared
 * destination carries its `override` when it has one, so the agent's effective definition is the
 * devices'. Throws {@link SetupError} for a choice the user has to fix.
 */
export function grantFor(
  choices: ApprovalChoices,
  destinations: readonly Destination[],
  settings: Settings | undefined,
  now: number
): AgentGrantInput {
  if (settings?.inbox_key === undefined || (settings.inbox_relays ?? []).length === 0) {
    throw new SetupError(
      'The queue settings name no inbox key or inbox relay, so an agent would have nowhere to send drafts.'
    );
  }
  const { quota } = choices;
  if (!Number.isInteger(quota.max_submissions) || quota.max_submissions < 1) {
    throw new SetupError('The quota must be a whole number of at least 1.');
  }
  const days = choices.submissionExpirationDays;
  if (!Number.isInteger(days) || days < 1 || days > MAX_SUBMISSION_EXPIRATION_DAYS) {
    throw new SetupError(
      `Submissions must expire after 1 to ${MAX_SUBMISSION_EXPIRATION_DAYS} days.`
    );
  }
  if (choices.expiresAt !== null && choices.expiresAt <= now) {
    throw new SetupError('The expiry date must be in the future.');
  }
  const shared: GrantDestination[] = [];
  const seen = new Set<string>();
  for (const choice of choices.destinations) {
    if (seen.has(choice.id)) continue;
    seen.add(choice.id);
    const destination = destinations.find((d) => d.id === choice.id);
    if (destination === undefined || destination.status !== 'confirmed') {
      throw new SetupError(
        'A chosen destination is no longer in the queue; reload and choose again.'
      );
    }
    const fields = [...new Set(choice.fields.map((f) => f.trim()).filter((f) => f !== ''))];
    if (fields.length === 0) {
      throw new SetupError(`Choose at least one field for ${destination.label}.`);
    }
    const entry: GrantDestination = {
      site: destination.site,
      account: destination.account,
      fields,
    };
    if (destination.override !== null) entry.override = destination.override;
    shared.push(entry);
  }
  return {
    inbox: [...(settings.inbox_relays ?? [])],
    inbox_pubkey: getPublicKey(hexToBytes(settings.inbox_key)),
    destinations: shared,
    allow_new_destinations: choices.allowNewDestinations,
    submission_expiration_days: days,
    quota: { max_submissions: quota.max_submissions, period: quota.period },
    expires_at: choices.expiresAt,
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const APPROVAL_PERMISSION_MESSAGE =
  'qus.me needs permission to reach app.qus.me to approve an agent, and to finish revoking it later.';

/**
 * Approves: asks for the service host permission, publishes the submitters list with the agent
 * added and the agent's grant to every storage relay, then posts the approval naming those
 * relays, retrying a 409 while the relays catch up. Resolves with the number of approval attempts.
 *
 * The permission is asked first (the look-up asked for it too, but the user may have removed it
 * since), inside the user's gesture, and an approval without it stops before publishing anything:
 * revoking the agent later needs the same permission to reach the service (11.8).
 */
export async function approveAgent(
  request: AuthorizationRequest,
  choices: ApprovalChoices,
  deps: AgentDeps
): Promise<{ attempts: number }> {
  const label = choices.label.trim();
  if (label === '') throw new SetupError('Give the agent a label.');
  // First thing awaited in the gesture: Firefox grants the permission only inside it.
  if (!(await deps.requestServicePermission())) {
    throw new SetupError(APPROVAL_PERMISSION_MESSAGE);
  }
  const prepared = await withQueue(deps, async (session) => {
    const snapshot = await readQueue(session);
    const grant = grantFor(
      choices,
      snapshot.destinations?.content.destinations ?? [],
      snapshot.settings?.content,
      session.now
    );
    const list = snapshot.submitters;
    const labels: Record<string, SubmitterLabel> = { ...(list?.labels ?? {}) };
    labels[request.agentPubkey] = { label, authorized_at: session.now };
    const submittersEvent = await buildSubmittersList(session.queue, labels, {
      createdAt: after(session.now, list?.createdAt),
      ...(list?.extra && { extra: list.extra }),
      ...(list?.extraTags && { extraTags: list.extraTags }),
    });
    const previousGrant = snapshot.grants.get(request.agentPubkey);
    // The queue's storage relays ride in the grant, so the service follows a later swap (7.4).
    const grantEvent = await buildAgentGrant(
      session.queue,
      request.agentPubkey,
      { ...grant, storage: [...session.record.storageRelays] },
      { createdAt: after(session.now, previousGrant?.createdAt) }
    );
    // The list first: it is what the service checks, and a grant without it authorizes nothing.
    await publishOrThrow(session, submittersEvent, 'submitters list');
    await publishOrThrow(session, grantEvent, 'agent grant');
    return { queue: session.queue, relays: session.record.storageRelays };
  });

  const delays = deps.approvalRetryMs ?? APPROVAL_RETRY_MS;
  for (let attempt = 0; ; attempt++) {
    const answer = await postApproval(prepared.queue, request.code, prepared.relays, deps);
    if (answer.ok) return { attempts: attempt + 1 };
    const delay = delays[attempt];
    if (answer.status === 409 && delay !== undefined && answer.error !== 'invalid_state') {
      await sleep(delay);
      continue;
    }
    if (answer.status === 409 && answer.error !== 'invalid_state') {
      throw new SetupError(
        `The service did not find the agent on the queue's submitters list (${answer.error}). ` +
          'The list was published; try approving again in a moment.'
      );
    }
    if (answer.status === 404) throw new SetupError('That request has expired.');
    if (answer.status === 409) throw new SetupError('That request was already approved or denied.');
    throw new SetupError(
      `The service refused the approval (${answer.status} ${answer.error}${answer.description ? `: ${answer.description}` : ''}).`
    );
  }
}

/** Denies: the service destroys the agent key. Nothing is published. */
export async function denyAgent(request: AuthorizationRequest, deps: AgentDeps): Promise<void> {
  const unlocked = await deps.store.unlocked();
  if (unlocked === undefined) throw new SetupError(LOCKED_MESSAGE);
  await postDenial(createLocalSigner(unlocked.queueKey), request.code, deps);
}

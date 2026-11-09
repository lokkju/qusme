/**
 * Changing an approved agent's grant (spec 7.4, 11.8): what it may draft for, the fields, whether
 * it may propose new destinations, its quota, how long its submissions last and when its access
 * ends, and its label in the submitters list. Like an approval, each change re-reads the queue
 * from every storage relay and needs every one of them to accept what it publishes.
 *
 * An edit never adds an agent to the submitters list or takes one off it, so it cannot undo a
 * revocation: an agent the list no longer names, or one with a revocation the service has not
 * confirmed yet (`pendingRevocations.ts`), is refused, and revoking stays the only way to remove
 * an agent and reach the service. The service reads the grant from the storage relays on each
 * call (8.4), so it needs no request of its own.
 */
import {
  type AgentGrant,
  type AgentGrantEvent,
  buildAgentGrant,
  buildSubmittersList,
  type Destination,
  type GrantDestination,
  type SubmitterLabel,
  sameAccount,
} from '@qusme/nostr';
import { effectiveDefinition, type SiteDefinitionSource } from '../insertion/definitions.ts';
import { SetupError } from '../setup/deps.ts';
import { type ApprovalChoices, DEFAULT_FIELDS, grantFor } from './approve.ts';
import { readPendingRevocations } from './pendingRevocations.ts';
import {
  type AgentDeps,
  after,
  publishOrThrow,
  type QueueSession,
  type QueueSnapshot,
  readQueue,
  withQueue,
} from './queue.ts';

/** The grant's destination that is this queue destination: same site, same account (10.1). */
function grantEntryFor(
  grant: Pick<AgentGrant, 'destinations'>,
  destination: Destination,
  source: SiteDefinitionSource | undefined
): GrantDestination | undefined {
  const rules = source && effectiveDefinition(source, destination.site, destination.override);
  return grant.destinations.find(
    (g) =>
      g.site === destination.site &&
      sameAccount(destination.site, g.account, destination.account, rules)
  );
}

export interface GrantEditStart {
  choices: ApprovalChoices;
  /**
   * Destinations in the grant that are no longer confirmed destinations of the queue (removed, or
   * merged away); saving the edit leaves them out, and the screen says so.
   */
  dropped: GrantDestination[];
}

/** The edit form's starting point: the agent's current grant, mapped onto the queue's destinations. */
export function choicesFromGrant(
  label: string,
  grant: AgentGrant,
  destinations: readonly Destination[],
  source?: SiteDefinitionSource
): GrantEditStart {
  const confirmed = destinations.filter((d) => d.status === 'confirmed');
  const chosen: ApprovalChoices['destinations'] = [];
  const matched = new Set<GrantDestination>();
  for (const destination of confirmed) {
    const entry = grantEntryFor(grant, destination, source);
    if (entry === undefined || matched.has(entry)) continue;
    matched.add(entry);
    chosen.push({ id: destination.id, fields: [...entry.fields] });
  }
  return {
    choices: {
      label,
      destinations: chosen,
      allowNewDestinations: grant.allow_new_destinations,
      quota: { max_submissions: grant.quota.max_submissions, period: grant.quota.period },
      submissionExpirationDays: grant.submission_expiration_days,
      expiresAt: grant.expires_at,
    },
    dropped: grant.destinations.filter((g) => !matched.has(g)),
  };
}

/** Refuses an agent that is not authorized now, so an edit never revives a revoked one. */
async function checkAuthorized(
  deps: AgentDeps,
  session: QueueSession,
  snapshot: QueueSnapshot,
  agentPubkey: string
): Promise<AgentGrantEvent> {
  const pending = await readPendingRevocations(deps.store, session.pubkey);
  if (
    !snapshot.submitters?.submitters.includes(agentPubkey) ||
    pending.some((p) => p.agentPubkey === agentPubkey)
  ) {
    throw new SetupError('That agent has been revoked, so its access can no longer be changed.');
  }
  const previous = snapshot.grants.get(agentPubkey);
  if (previous === undefined) {
    throw new SetupError(
      "No storage relay has that agent's grant. Revoke it and approve it again to give it one."
    );
  }
  return previous;
}

/**
 * The grant for `choices`, keeping what this version does not edit: `min_pow`, unknown keys at
 * every level, and the event's extra tags (spec 7, "Unknown fields").
 */
function mergedGrant(
  previous: AgentGrantEvent,
  choices: ApprovalChoices,
  snapshot: QueueSnapshot,
  now: number
): AgentGrant {
  const destinations = snapshot.destinations?.content.destinations ?? [];
  const next = grantFor(choices, destinations, snapshot.settings?.content, now);
  const old = previous.grant;
  const shared = next.destinations.map((entry): GrantDestination => {
    const before = old.destinations.find(
      (g) => g.site === entry.site && g.account === entry.account
    );
    return before?.extra !== undefined ? { ...entry, extra: before.extra } : entry;
  });
  const grant: AgentGrant = {
    ...next,
    min_pow: old.min_pow,
    allow_new_destinations: next.allow_new_destinations ?? false,
    submission_expiration_days: next.submission_expiration_days ?? old.submission_expiration_days,
    expires_at: next.expires_at ?? null,
    destinations: shared,
    quota: old.quota.extra !== undefined ? { ...next.quota, extra: old.quota.extra } : next.quota,
  };
  if (old.extra !== undefined) grant.extra = old.extra;
  return grant;
}

async function publishGrant(
  session: QueueSession,
  previous: AgentGrantEvent,
  grant: AgentGrant
): Promise<void> {
  const event = await buildAgentGrant(session.queue, previous.agentPubkey, grant, {
    createdAt: after(session.now, previous.createdAt),
    ...(previous.extraTags && { extraTags: previous.extraTags }),
  });
  await publishOrThrow(session, event, 'agent grant');
}

/**
 * Republishes the agent's grant from the edited choices, and the submitters list when its label
 * changed. The grant goes first: a list republished for a label alone changes nothing an agent
 * relies on.
 */
export async function editGrant(
  agentPubkey: string,
  choices: ApprovalChoices,
  deps: AgentDeps
): Promise<AgentGrant> {
  const label = choices.label.trim();
  if (label === '') throw new SetupError('Give the agent a label.');
  return withQueue(deps, async (session) => {
    const snapshot = await readQueue(session);
    const previous = await checkAuthorized(deps, session, snapshot, agentPubkey);
    const grant = mergedGrant(previous, choices, snapshot, session.now);
    await publishGrant(session, previous, grant);
    const list = snapshot.submitters;
    const current = list?.labels[agentPubkey];
    if (list !== undefined && current?.label !== label) {
      const labels: Record<string, SubmitterLabel> = { ...list.labels };
      labels[agentPubkey] = { ...(current ?? { authorized_at: session.now }), label };
      const event = await buildSubmittersList(session.queue, labels, {
        createdAt: after(session.now, list.createdAt),
        ...(list.extra && { extra: list.extra }),
        ...(list.extraTags && { extraTags: list.extraTags }),
      });
      await publishOrThrow(session, event, 'submitters list');
    }
    return grant;
  });
}

/**
 * Adds one confirmed destination, with the default field, to each named agent's grant (UX audit
 * 3.2: offered right after a destination is added or confirmed). An agent whose grant already has
 * it is left as it is. Resolves with the agents whose grant changed.
 */
export async function shareDestination(
  destinationId: string,
  agentPubkeys: readonly string[],
  deps: AgentDeps,
  source?: SiteDefinitionSource
): Promise<string[]> {
  if (agentPubkeys.length === 0) return [];
  return withQueue(deps, async (session) => {
    const snapshot = await readQueue(session);
    const destinations = snapshot.destinations?.content.destinations ?? [];
    const destination = destinations.find((d) => d.id === destinationId);
    if (destination === undefined || destination.status !== 'confirmed') {
      throw new SetupError(
        'That destination is not confirmed; another device may have changed it.'
      );
    }
    const changed: string[] = [];
    for (const agentPubkey of agentPubkeys) {
      const previous = await checkAuthorized(deps, session, snapshot, agentPubkey);
      // An expired grant authorizes nothing; sharing with it would only fail its expiry check.
      if (previous.grant.expires_at !== null && previous.grant.expires_at <= session.now) continue;
      const label = snapshot.submitters?.labels[agentPubkey]?.label ?? '';
      const start = choicesFromGrant(label, previous.grant, destinations, source);
      if (start.choices.destinations.some((c) => c.id === destinationId)) continue;
      const choices: ApprovalChoices = {
        ...start.choices,
        destinations: [
          ...start.choices.destinations,
          { id: destinationId, fields: [...DEFAULT_FIELDS] },
        ],
      };
      // Destinations the grant names that the queue no longer has stay in it: sharing one more
      // destination is not the place to drop them silently.
      const grant = mergedGrant(previous, choices, snapshot, session.now);
      grant.destinations = [...grant.destinations, ...start.dropped];
      await publishGrant(session, previous, grant);
      changed.push(agentPubkey);
    }
    return changed;
  });
}

/** An agent row's parts {@link shareCandidates} reads. */
interface CandidateRow {
  agentPubkey: string;
  listed: boolean;
  grant?: AgentGrant;
  pendingRevocation?: unknown;
}

/**
 * The agents a newly added or confirmed destination can be shared with: authorized now, with a
 * grant that has not expired and does not already include it.
 */
export function shareCandidates<T extends CandidateRow>(
  agents: readonly T[],
  destination: Destination,
  now: number,
  source?: SiteDefinitionSource
): T[] {
  return agents.filter(
    (a) =>
      a.listed &&
      a.pendingRevocation === undefined &&
      a.grant !== undefined &&
      (a.grant.expires_at === null || a.grant.expires_at > now) &&
      grantEntryFor(a.grant, destination, source) === undefined
  );
}

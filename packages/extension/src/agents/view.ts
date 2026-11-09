/**
 * What the agent screens show, read fresh from the storage relays and, for the bindings, the
 * service. Labels come from the queue's own submitters list; client names and hosts come from the
 * service, which got them from each client's metadata document.
 */
import {
  type AgentGrant,
  createLocalSigner,
  type Destination,
  type QuotaCount,
  quotaPeriodStart,
} from '@qusme/nostr';
import { SetupError } from '../setup/deps.ts';
import {
  type PendingRevocation,
  readPendingRevocations,
  removePendingRevocation,
} from './pendingRevocations.ts';
import { type AgentDeps, LOCKED_MESSAGE, readQueue, withQueue } from './queue.ts';
import { type Binding, listBindings } from './service.ts';

export interface AgentRow {
  agentPubkey: string;
  /** From the submitters list; absent when the agent is bound but no longer listed. */
  label?: string;
  authorizedAt?: number;
  /** Whether the current submitters list names it, which is what authorizes it (7.3). */
  listed: boolean;
  /** The service's binding; absent when the service was not asked or no longer holds it. */
  binding?: Binding;
  grant?: AgentGrant;
  /**
   * Its submissions devices counted in the grant's current quota period, from the settings'
   * `quota_counts` (7.2, 11.4); absent without a grant.
   */
  counts?: { accepted: number; discarded: number };
  /**
   * Revoked on this device, but the service has not confirmed it yet (11.8): shown as "finishing
   * with qus.me" with a Retry.
   */
  pendingRevocation?: Pick<PendingRevocation, 'since' | 'lastError'>;
}

export interface AgentsView {
  agents: AgentRow[];
  /** Destinations agents proposed, waiting for the user (7.2). */
  pending: Destination[];
  /** Confirmed destinations: what a grant can share and a pending one can merge into. */
  confirmed: Destination[];
  /** Why the service's list is missing, when it was asked and failed. */
  bindingsError?: string;
}

/**
 * What the devices accepted and discarded in the grant's current period. A record from an earlier
 * period counts nothing now: the next ingestion clears it (11.4).
 */
export function countsInPeriod(
  count: QuotaCount | undefined,
  grant: Pick<AgentGrant, 'quota'>,
  now: number
): { accepted: number; discarded: number } {
  if (count === undefined || count.period_start < quotaPeriodStart(grant.quota.period, now)) {
    return { accepted: 0, discarded: 0 };
  }
  return { accepted: count.accepted.length, discarded: count.discarded.length };
}

/** Listed submitters joined with the service's bindings, and the pending destinations. */
export async function loadAgents(
  deps: AgentDeps,
  options: { withService: boolean }
): Promise<AgentsView> {
  const snapshot = await withQueue(deps, (session) => readQueue(session));
  const destinations = snapshot.destinations?.content.destinations ?? [];
  const view: AgentsView = {
    agents: [],
    pending: destinations.filter((d) => d.status === 'pending'),
    confirmed: destinations.filter((d) => d.status === 'confirmed'),
  };
  let bindings: Binding[] = [];
  if (options.withService) {
    const unlocked = await deps.store.unlocked();
    if (unlocked === undefined) throw new SetupError(LOCKED_MESSAGE);
    try {
      bindings = await listBindings(createLocalSigner(unlocked.queueKey), deps);
    } catch (error) {
      view.bindingsError = (error as Error).message;
    }
  }
  const labels = snapshot.submitters?.labels ?? {};
  for (const agentPubkey of snapshot.submitters?.submitters ?? []) {
    const row: AgentRow = { agentPubkey, listed: true };
    const label = labels[agentPubkey];
    if (label !== undefined) {
      row.label = label.label;
      row.authorizedAt = label.authorized_at;
    }
    const binding = bindings.find((b) => b.agentPubkey === agentPubkey);
    if (binding !== undefined) row.binding = binding;
    const grant = snapshot.grants.get(agentPubkey)?.grant;
    if (grant !== undefined) {
      row.grant = grant;
      row.counts = countsInPeriod(
        snapshot.settings?.content.quota_counts[agentPubkey],
        grant,
        deps.now?.() ?? Math.floor(Date.now() / 1000)
      );
    }
    view.agents.push(row);
  }
  for (const binding of bindings) {
    if (view.agents.some((a) => a.agentPubkey === binding.agentPubkey)) continue;
    view.agents.push({ agentPubkey: binding.agentPubkey, listed: false, binding });
  }
  const queuePubkey = (await deps.store.record())?.pubkey;
  const pending =
    queuePubkey === undefined ? [] : await readPendingRevocations(deps.store, queuePubkey);
  const serviceListed = options.withService && view.bindingsError === undefined;
  for (const item of pending) {
    const row = view.agents.find((a) => a.agentPubkey === item.agentPubkey);
    if (row?.listed) continue;
    if (serviceListed && row === undefined && queuePubkey !== undefined) {
      // The service answered and no longer holds it: the revocation finished another way.
      await removePendingRevocation(deps.store, queuePubkey, item.agentPubkey);
      continue;
    }
    const state: AgentRow['pendingRevocation'] = { since: item.since };
    if (item.lastError !== undefined) state.lastError = item.lastError;
    if (row !== undefined) {
      row.pendingRevocation = state;
      if (row.label === undefined && item.label !== undefined) row.label = item.label;
    } else {
      view.agents.push({
        agentPubkey: item.agentPubkey,
        listed: false,
        ...(item.label !== undefined && { label: item.label }),
        pendingRevocation: state,
      });
    }
  }
  return view;
}

/** The confirmed destinations an approval can share. */
export async function loadShareableDestinations(deps: AgentDeps): Promise<Destination[]> {
  const snapshot = await withQueue(deps, (session) => readQueue(session));
  return (snapshot.destinations?.content.destinations ?? []).filter(
    (d) => d.status === 'confirmed'
  );
}

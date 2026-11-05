/**
 * What the agent screens show, read fresh from the storage relays and, for the bindings, the
 * service. Labels come from the queue's own submitters list; client names and hosts come from the
 * service, which got them from each client's metadata document.
 */
import { type AgentGrant, createLocalSigner, type Destination } from '@qusme/nostr';
import { SetupError } from '../setup/deps.ts';
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
}

export interface AgentsView {
  agents: AgentRow[];
  /** Destinations agents proposed, waiting for the user (7.2). */
  pending: Destination[];
  /** Why the service's list is missing, when it was asked and failed. */
  bindingsError?: string;
}

/** Listed submitters joined with the service's bindings, and the pending destinations. */
export async function loadAgents(
  deps: AgentDeps,
  options: { withService: boolean }
): Promise<AgentsView> {
  const snapshot = await withQueue(deps, (session) => readQueue(session));
  const view: AgentsView = {
    agents: [],
    pending: (snapshot.destinations?.content.destinations ?? []).filter(
      (d) => d.status === 'pending'
    ),
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
    if (grant !== undefined) row.grant = grant;
    view.agents.push(row);
  }
  for (const binding of bindings) {
    if (view.agents.some((a) => a.agentPubkey === binding.agentPubkey)) continue;
    view.agents.push({ agentPubkey: binding.agentPubkey, listed: false, binding });
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

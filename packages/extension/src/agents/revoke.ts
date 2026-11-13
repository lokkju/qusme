/**
 * Revoking an agent (spec 8.2, "Revocation", 11.8): remove it from the submitters list on every
 * storage relay, which devices, the service and a relay meeting the qus.me relay profile enforce,
 * ask the relays to delete its grant, and then tell the service to destroy the key and its tokens.
 * The service step is part of the revocation: until it is done the revocation stays pending in
 * `storage.local` (`pendingRevocations.ts`) and each sync retries it.
 */
import {
  buildDeletionRequest,
  buildSubmittersList,
  KIND_AGENT_GRANT,
  type SubmitterLabel,
} from '@qusme/nostr';
import { SetupError } from '../setup/deps.ts';
import { addPendingRevocation, finishRevocation } from './pendingRevocations.ts';
import { type AgentDeps, after, publishAll, readQueue, withQueue } from './queue.ts';

export interface RevokeResult {
  /** Whether a new submitters list without the agent went out (false if it was not listed). */
  listUpdated: boolean;
  /** Storage relays that refused the new list. */
  refusals: string[];
  /**
   * What the service said, or `pending` when it could not be told (offline, no permission): the
   * revocation is then recorded as pending and retried on each sync.
   */
  service: 'revoked' | 'not_bound' | 'pending';
  /** Why the service could not be told, written for the user. */
  serviceError?: string;
  /** A local MCP server's agent (labelled `local`), which the service never held. */
  local?: boolean;
}

/** The address of an agent's grant, `31235:<queue pubkey>:<agent pubkey>`. */
export const grantAddress = (queuePubkey: string, agentPubkey: string): string =>
  `${KIND_AGENT_GRANT}:${queuePubkey}:${agentPubkey}`;

export const NO_SERVICE_PERMISSION =
  'qus.me does not have permission to reach app.qus.me. Press Retry and allow it.';

/**
 * Removes the agent from the submitters list and requests deletion of its grant on every storage
 * relay, then revokes it at the service. The list goes first: it is the authority (7.3), and it
 * takes effect whether or not the service cooperates. The revocation is recorded as pending once
 * the list is out and cleared when the service confirms; `serviceAllowed: false` (the user
 * declined the host permission) skips the request, which would fail, and leaves it pending.
 * Throws only if no storage relay accepted the new list.
 */
export async function revokeAgent(
  agentPubkey: string,
  deps: AgentDeps,
  options: { serviceAllowed?: boolean } = {}
): Promise<RevokeResult> {
  const result = await withQueue(deps, async (session): Promise<RevokeResult> => {
    const snapshot = await readQueue(session);
    const list = snapshot.submitters;
    const out: RevokeResult = { listUpdated: false, refusals: [], service: 'pending' };
    if (list?.submitters.includes(agentPubkey)) {
      const labels: Record<string, SubmitterLabel> = { ...list.labels };
      delete labels[agentPubkey];
      const event = await buildSubmittersList(session.queue, labels, {
        createdAt: after(session.now, list.createdAt),
        ...(list.extra && { extra: list.extra }),
        ...(list.extraTags && { extraTags: list.extraTags }),
      });
      out.refusals = await publishAll(session, event);
      if (out.refusals.length === session.connections.length) {
        throw new SetupError(
          `No storage relay accepted the new submitters list: ${out.refusals.join('; ')}`
        );
      }
      out.listUpdated = true;
    }
    // A local MCP server (spec 8.6) has no binding at the service: the list is the whole revocation.
    if (list?.labels[agentPubkey]?.extra?.local === true) {
      out.service = 'not_bound';
      out.local = true;
    }
    // Before anything else can fail: the popup may close at any moment from here on.
    const label = list?.labels[agentPubkey]?.label;
    if (!out.local)
      await addPendingRevocation(deps.store, {
        queuePubkey: session.pubkey,
        agentPubkey,
        since: session.now,
        ...(label !== undefined && { label }),
        ...(options.serviceAllowed === false && { lastError: NO_SERVICE_PERMISSION }),
      });
    const grant = snapshot.grants.get(agentPubkey);
    if (grant !== undefined) {
      // Best effort: the list already revoked the agent, and an ordinary relay may keep the grant.
      const deletion = await buildDeletionRequest(
        session.queue,
        { eventIds: [grant.id], addresses: [grantAddress(session.pubkey, agentPubkey)] },
        { createdAt: session.now }
      );
      await publishAll(session, deletion);
    }
    return out;
  });
  if (result.local) return result;
  if (options.serviceAllowed === false) {
    result.serviceError = NO_SERVICE_PERMISSION;
    return result;
  }
  try {
    result.service = await finishRevocation(agentPubkey, deps);
  } catch (error) {
    result.serviceError = (error as Error).message;
  }
  return result;
}

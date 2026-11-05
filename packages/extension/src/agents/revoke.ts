/**
 * Revoking an agent (spec 8.2, "Revocation"): remove it from the submitters list on every storage
 * relay, which devices and a relay meeting the qus.me relay profile enforce at once, ask the
 * relays to delete its grant, and then tell the service to destroy the key and its tokens.
 */
import {
  buildDeletionRequest,
  buildSubmittersList,
  createLocalSigner,
  KIND_AGENT_GRANT,
  type SubmitterLabel,
} from '@qusme/nostr';
import { SetupError } from '../setup/deps.ts';
import {
  type AgentDeps,
  after,
  LOCKED_MESSAGE,
  publishAll,
  readQueue,
  withQueue,
} from './queue.ts';
import { deleteBinding } from './service.ts';

export interface RevokeResult {
  /** Whether a new submitters list without the agent went out (false if it was not listed). */
  listUpdated: boolean;
  /** Storage relays that refused the new list. */
  refusals: string[];
  /** What the service said, or `skipped` when it was not asked. */
  service: 'revoked' | 'not_bound' | 'failed' | 'skipped';
  /** Why the service could not be told, written for the user. */
  serviceError?: string;
}

/** The address of an agent's grant, `31235:<queue pubkey>:<agent pubkey>`. */
export const grantAddress = (queuePubkey: string, agentPubkey: string): string =>
  `${KIND_AGENT_GRANT}:${queuePubkey}:${agentPubkey}`;

/**
 * Removes the agent from the submitters list and requests deletion of its grant on every storage
 * relay, then, with `tellService` (the default), revokes it at the service. The list goes first:
 * it is the authority (7.3), and it takes effect whether or not the service cooperates. Throws
 * only if no storage relay accepted the new list.
 */
export async function revokeAgent(
  agentPubkey: string,
  deps: AgentDeps,
  options: { tellService?: boolean } = {}
): Promise<RevokeResult> {
  const result = await withQueue(deps, async (session): Promise<RevokeResult> => {
    const snapshot = await readQueue(session);
    const list = snapshot.submitters;
    const out: RevokeResult = { listUpdated: false, refusals: [], service: 'skipped' };
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
  if (options.tellService ?? true) {
    const unlocked = await deps.store.unlocked();
    if (unlocked === undefined) throw new SetupError(LOCKED_MESSAGE);
    try {
      result.service = await deleteBinding(createLocalSigner(unlocked.queueKey), agentPubkey, deps);
    } catch (error) {
      result.service = 'failed';
      result.serviceError = (error as Error).message;
    }
  }
  return result;
}

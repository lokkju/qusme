/**
 * The agent's grant (spec 7.4), read from the queue's storage relays as the agent key and
 * decrypted with it. The newest valid grant signed by the bound queue wins. A found grant is kept
 * for a short while per agent key, binding and relays, so a burst of tool calls reads the relays
 * once; a missing one is not kept, so a device that has just published can be retried at once.
 */
import { AGENT_GRANT_KINDS, type AgentGrant, parseAgentGrant, type Signer } from '@qusme/nostr';
import type { RelayReader } from '../oauth/relayReader.ts';
import type { AgentAuth } from '../oauth/server.ts';

export interface FoundGrant {
  /** The grant event's id. */
  eventId: string;
  createdAt: number;
  grant: AgentGrant;
}

export interface GrantCacheOptions {
  relayReader: RelayReader;
  /** Seconds a found grant is reused. 0 turns the cache off. */
  ttlSeconds: number;
  /** Most agent keys kept; the oldest entry goes first. */
  maxEntries?: number;
}

export interface GrantCache {
  /** The current grant, or undefined if none on the relays is valid for this agent and queue. */
  get(agent: AgentAuth, signer: Signer, now: number): Promise<FoundGrant | undefined>;
  /** Forgets every cached grant. */
  clear(): void;
}

export function createGrantCache(options: GrantCacheOptions): GrantCache {
  const maxEntries = options.maxEntries ?? 1_000;
  const cache = new Map<string, { until: number; found: FoundGrant }>();

  async function read(agent: AgentAuth, signer: Signer): Promise<FoundGrant | undefined> {
    const events = await options.relayReader.query({
      relays: agent.storageRelays,
      filter: {
        kinds: [...AGENT_GRANT_KINDS],
        authors: [agent.queuePubkey],
        '#d': [agent.agentPubkey],
        limit: 1,
      },
      auth: signer,
    });
    let best: FoundGrant | undefined;
    for (const event of events) {
      const parsed = await parseAgentGrant(event, signer);
      if (!parsed.ok) continue;
      const g = parsed.value;
      // Anyone can encrypt a grant to the agent; only the bound queue's counts.
      if (g.pubkey !== agent.queuePubkey || g.agentPubkey !== agent.agentPubkey) continue;
      // NIP-01: the newest replaces; on a tie the lowest id wins.
      if (
        best === undefined ||
        g.createdAt > best.createdAt ||
        (g.createdAt === best.createdAt && g.id < best.eventId)
      ) {
        best = { eventId: g.id, createdAt: g.createdAt, grant: g.grant };
      }
    }
    return best;
  }

  return {
    async get(agent, signer, now) {
      const key = [agent.agentKeyId, agent.queuePubkey, ...agent.storageRelays].join(' ');
      const hit = cache.get(key);
      if (hit !== undefined && hit.until > now) return hit.found;
      cache.delete(key);
      const found = await read(agent, signer);
      if (found !== undefined && options.ttlSeconds > 0) {
        if (cache.size >= maxEntries) {
          const oldest = cache.keys().next();
          if (!oldest.done) cache.delete(oldest.value);
        }
        cache.set(key, { until: now + options.ttlSeconds, found });
      }
      return found;
    },
    clear() {
      cache.clear();
    },
  };
}

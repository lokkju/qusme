/**
 * The agent's grant (spec 7.4), read from the queue's storage relays as the agent key and
 * decrypted with it, and the queue's current submitters list (7.3), read the same way. The newest
 * valid event signed by the bound queue wins. A found event is kept for a short while per agent
 * key, binding and relays, so a burst of tool calls reads the relays once; a missing one is not
 * kept, so a device that has just published can be retried at once.
 */
import {
  AGENT_GRANT_KINDS,
  type AgentGrant,
  parseAgentGrant,
  parseSubmittersPublic,
  type Signer,
  SUBMITTERS_KINDS,
} from '@qusme/nostr';
import { checkStorageRelays, type RelayReader } from '../oauth/relayReader.ts';
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

/** A per-agent cache of something read from the storage relays; only found values are kept. */
function agentCache<T>(
  options: GrantCacheOptions,
  read: (agent: AgentAuth, signer: Signer) => Promise<T | undefined>
) {
  const maxEntries = options.maxEntries ?? 1_000;
  const cache = new Map<string, { until: number; found: T }>();
  return {
    async get(agent: AgentAuth, signer: Signer, now: number): Promise<T | undefined> {
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

export function createGrantCache(options: GrantCacheOptions): GrantCache {
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

  return agentCache(options, read);
}

/**
 * The storage relays to move the agent's binding to, when its grant names a different set than
 * the binding's and is newer than the grant the binding last moved for (spec 7.4, 8.4); otherwise
 * undefined. The grant must come from {@link GrantCache}, which keeps only grants signed by the
 * bound queue for this agent. A grant without `storage`, or whose relays fail the checks an
 * approval's relays pass (`checkStorageRelays`: `wss://`, allowed hosts, at most 5), moves nothing.
 */
export function storageMoveFor(agent: AgentAuth, found: FoundGrant): string[] | undefined {
  const { storage } = found.grant;
  if (storage === undefined) return undefined;
  if (agent.storageGrantAt !== null && found.createdAt <= agent.storageGrantAt) return undefined;
  const relays = checkStorageRelays(storage);
  if (typeof relays === 'string') return undefined;
  const bound = new Set(agent.storageRelays);
  if (relays.length === bound.size && relays.every((url) => bound.has(url))) return undefined;
  return relays;
}

/** The queue's current submitters list as the service reads it: the public `p` tags. */
export interface FoundSubmitters {
  /** The list event's id. */
  eventId: string;
  createdAt: number;
  /** Agent pubkeys the list names. */
  submitters: string[];
}

export interface SubmittersCache {
  /**
   * The newest submitters list signed by the bound queue on its storage relays, or undefined if
   * none was found (no list, or no relay answered).
   */
  get(agent: AgentAuth, signer: Signer, now: number): Promise<FoundSubmitters | undefined>;
  /** Forgets every cached list. */
  clear(): void;
}

/**
 * The submitters list (7.3) is the authority on authorization: a grant left behind on a relay that
 * ignored its deletion does not make an agent the list dropped a submitter again (8.4). Cached as
 * grants are, per agent key, since a relay meeting the qus.me relay profile answers each agent
 * according to whether the list names it (9.2).
 */
export function createSubmittersCache(options: GrantCacheOptions): SubmittersCache {
  async function read(agent: AgentAuth, signer: Signer): Promise<FoundSubmitters | undefined> {
    let events: unknown[];
    try {
      events = await options.relayReader.query({
        relays: agent.storageRelays,
        filter: { kinds: [...SUBMITTERS_KINDS], authors: [agent.queuePubkey], limit: 1 },
        auth: signer,
      });
    } catch {
      return undefined;
    }
    let best: FoundSubmitters | undefined;
    for (const event of events) {
      const parsed = parseSubmittersPublic(event, { queuePubkey: agent.queuePubkey });
      if (!parsed.ok) continue;
      const list = parsed.value;
      if (
        best === undefined ||
        list.createdAt > best.createdAt ||
        (list.createdAt === best.createdAt && list.id < best.eventId)
      ) {
        best = { eventId: list.id, createdAt: list.createdAt, submitters: list.submitters };
      }
    }
    return best;
  }

  return agentCache(options, read);
}

/**
 * The MCP endpoint (spec 8.4): stateless streamable HTTP through the official MCP TypeScript SDK,
 * mounted at `/mcp` behind the bearer check, which resolves the token to `c.var.agent`. Each
 * request gets a fresh server whose tools (`tools.ts`, shared with the local server of spec 8.6)
 * act for that agent through a {@link ToolSession} made here from the database, the agent key
 * custody and the service's limits.
 *
 * Every tool but `list_registry` needs a current grant (7.4), read from the queue's storage
 * relays as the agent key, and an agent the queue's current submitters list (7.3) still names: a
 * list that dropped the agent revokes it even where a relay kept the grant. Failures are tool
 * results with `isError` and structured content naming the error, so a client can tell a
 * constraint violation from an exhausted quota.
 */
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { createStore, type QusmeDb, type Store } from '@qusme/store-sql';
import type { Context } from 'hono';
import type { AgentKeyRing } from '../agentKeyRing.ts';
import { type AgentKeyCustody, createAgentKeyCustody } from '../agentKeys.ts';
import {
  BODY_LIMITS,
  createServiceLimits,
  type ServiceLimits,
  type TierLimits,
  tooManyRequests,
  utcDay,
} from '../limits.ts';
import type { RelayReader } from '../oauth/relayReader.ts';
import type { McpAuthEnv } from '../oauth/server.ts';
import {
  createGrantCache,
  createSubmittersCache,
  type FoundGrant,
  type GrantCache,
  type SubmittersCache,
  storageMoveFor,
} from './grants.ts';
import { loadRegistry, type Registry, type RegistrySnapshot } from './registry.ts';
import { createWebSocketRelayPublisher, type RelayPublisher } from './relayPublisher.ts';
import {
  checkGrant,
  type McpToolErrorCode,
  QUSME_INSTRUCTIONS,
  registerQusmeTools,
  ToolError,
  type ToolSession,
} from './tools.ts';

export { MAX_SUBMISSIONS_PAGE } from './tools.ts';
export type { McpToolErrorCode };

const DAY = 86_400;

/**
 * Most NIP-13 difficulty the service mines by default (spec 7.4): 2^5 = 32 hashes on average.
 * Measured under workerd (packages/nostr/scripts/pow-bench.ts), one hash of a gift wrap costs
 * about 20 ns per byte, 37 µs for a short value's 1.6 KB wrap, so 5 bits of a short value take
 * about 1 ms of the Workers Free plan's 10 ms per request and 8 bits would take the whole 10 ms.
 * A deployment with more CPU raises it (`QUSME_MAX_POW`).
 */
export const DEFAULT_MAX_POW = 5;
/**
 * Bytes of serialized gift wrap the miner may hash per expected hash at the cap: the budget is
 * 2^maxPow times this, 256 KiB (about 5 ms) at the default. A short value's wrap gets about five
 * times its expected work before mining gives up (one try in 150 fails); a wrap whose expected
 * work alone exceeds the budget is refused without mining.
 */
export const POW_BYTES_PER_HASH = 8 * 1024;
/** Most `QUSME_MAX_POW` may be: NIP-13 difficulty counts the leading zero bits of a 256-bit id. */
const MAX_POW_LIMIT = 256;
/** Seconds a grant read from the relays is reused by default. */
export const DEFAULT_GRANT_CACHE_SECONDS = 30;
/** Largest request body: a 32 KiB value, JSON-escaped, with room for the envelope. */
const MAX_REQUEST_BYTES = BODY_LIMITS.mcp;
/** The usage counter scope of the service-wide daily create_draft ceiling. */
export const DRAFT_CEILING_SCOPE = 'create_draft';

/** What an entrypoint or a test may override; everything has a default. */
export interface McpOverrides {
  /** Bundled site definitions (10.3), as published JSON. Empty by default. */
  registry?: RegistrySnapshot;
  /** Reads grants from storage relays; the OAuth server's reader by default. */
  relayReader?: RelayReader;
  /** Publishes gift wraps to inbox relays; WebSockets by default. */
  relayPublisher?: RelayPublisher;
  /** Unix seconds. */
  now?: () => number;
  /** Seconds a grant or submitters list is reused; 0 reads the relays on every call. */
  grantCacheSeconds?: number;
  /**
   * Told when a tool went ahead without the submitters list because no storage relay returned one
   * (8.4). The MCP modules log nothing themselves; an entrypoint logs what this passes, which is
   * pubkeys only.
   */
  notice?: (notice: McpNotice) => void;
  /**
   * Highest grant `min_pow` the service mines (`QUSME_MAX_POW`), 0 to 256; a grant asking more is
   * refused. It also sets the mining budget: 2^maxPow × {@link POW_BYTES_PER_HASH} bytes hashed.
   */
  maxPow?: number;
}

export interface McpOptions extends McpOverrides {
  db: QusmeDb;
  agentKeys: AgentKeyRing;
  relayReader: RelayReader;
  version: string;
  /** Rate limits, caps and tiers (spec 8.5, "Limits"); in-memory defaults when left out. */
  limits?: ServiceLimits;
}

/** Something an operator may want to see; carries no key material and no submitted value. */
export interface McpNotice {
  /**
   * `submitters_list_unavailable`: a tool went ahead on the grant alone (8.4).
   * `storage_relays_moved`: a newer grant named other storage relays and the binding follows them.
   */
  event: 'submitters_list_unavailable' | 'storage_relays_moved';
  agentPubkey: string;
  queuePubkey: string;
}

interface Session {
  agent: McpAuthEnv['Variables']['agent'];
  now: number;
  /** The limits of the agent's queue's tier. */
  tier: TierLimits;
  /** Seconds to wait when this request is over a rate limit; tools then refuse. */
  rateLimited?: number;
}

/** True when a JSON-RPC body (one message or a batch) calls a tool. */
function callsTool(text: string): boolean {
  try {
    const parsed: unknown = JSON.parse(text);
    const messages = Array.isArray(parsed) ? parsed : [parsed];
    return messages.some(
      (m) =>
        typeof m === 'object' && m !== null && (m as { method?: unknown }).method === 'tools/call'
    );
  } catch {
    return false;
  }
}

export function createMcp(options: McpOptions) {
  const store: Store = createStore(options.db);
  const custody: AgentKeyCustody = createAgentKeyCustody(store, options.agentKeys);
  const registry: Registry = loadRegistry(options.registry);
  const publisher = options.relayPublisher ?? createWebSocketRelayPublisher();
  const cacheOptions = {
    relayReader: options.relayReader,
    ttlSeconds: options.grantCacheSeconds ?? DEFAULT_GRANT_CACHE_SECONDS,
  };
  const grants: GrantCache = createGrantCache(cacheOptions);
  const submitters: SubmittersCache = createSubmittersCache(cacheOptions);
  const maxPow = options.maxPow ?? DEFAULT_MAX_POW;
  if (!Number.isInteger(maxPow) || maxPow < 0 || maxPow > MAX_POW_LIMIT) {
    throw new Error(`maxPow (QUSME_MAX_POW) must be a whole number from 0 to ${MAX_POW_LIMIT}`);
  }
  const powMaxBytes = 2 ** maxPow * POW_BYTES_PER_HASH;
  const clock = options.now ?? (() => Math.floor(Date.now() / 1000));
  const limits = options.limits ?? createServiceLimits({ now: clock });

  /**
   * The current grant or a ToolError; read as the agent key (7.4). The submitters list is read
   * alongside it: when one is found and no longer names the agent, the user revoked it, whatever
   * grant a relay still holds. When none is found the grant alone decides, as before the check.
   */
  async function currentGrant(session: Session): Promise<FoundGrant> {
    const { agent, now } = session;
    let found: FoundGrant | undefined;
    let list: Awaited<ReturnType<SubmittersCache['get']>>;
    try {
      [found, list] = await custody.withAgentKey(agent.agentKeyId, (signer) =>
        Promise.all([grants.get(agent, signer, now), submitters.get(agent, signer, now)])
      );
    } catch {
      throw new ToolError('grant_not_found', 'the agent grant could not be read');
    }
    const checked = checkGrant(found, list?.submitters, agent.agentPubkey, now);
    // Going ahead on the grant alone: worth an operator's attention if it keeps happening.
    if (list === undefined) {
      options.notice?.({
        event: 'submitters_list_unavailable',
        agentPubkey: agent.agentPubkey,
        queuePubkey: agent.queuePubkey,
      });
    }
    await followStorage(session, checked);
    return checked;
  }

  /**
   * Moves the agent's binding to the storage relays its grant names, when the grant is newer than
   * the one the binding last moved for (7.4, 8.4), so the next call reads the grant and the
   * submitters list there. The store's guard makes it one conditional statement; a failure leaves
   * the binding as it was and the call goes on.
   */
  async function followStorage(session: Session, found: FoundGrant): Promise<void> {
    const { agent, now } = session;
    const relays = storageMoveFor(agent, found);
    if (relays === undefined) return;
    let moved: Awaited<ReturnType<Store['bindings']['moveStorage']>>;
    try {
      moved = await store.bindings.moveStorage(
        agent.agentKeyId,
        agent.queuePubkey,
        relays,
        found.createdAt,
        now
      );
    } catch {
      return;
    }
    if (moved === undefined) return;
    agent.storageRelays = moved.storageRelays;
    agent.storageGrantAt = moved.storageGrantAt;
    options.notice?.({
      event: 'storage_relays_moved',
      agentPubkey: agent.agentPubkey,
      queuePubkey: agent.queuePubkey,
    });
  }

  /**
   * The queue's own daily cap (its tier), counted from receipts, then the service-wide ceiling,
   * reserved exactly before publishing and given back if nothing is published (8.5, "Limits").
   */
  async function reserve(session: Session): Promise<() => Promise<void>> {
    const { now } = session;
    const day = utcDay(now);
    const queueUsed = await store.submissionReceipts.countByQueueSince(
      session.agent.queuePubkey,
      day.start
    );
    if (queueUsed >= session.tier.draftsPerDay) {
      throw new ToolError(
        'quota_exhausted',
        `This qus.me queue has reached its limit of ${session.tier.draftsPerDay} drafts per day. ` +
          `Nothing was submitted. Retry after ${day.retryAfter} seconds (00:00 UTC).`,
        {
          scope: 'queue',
          max_submissions: session.tier.draftsPerDay,
          period: 'day',
          used: queueUsed,
          resets_at: day.end,
          retry_after: day.retryAfter,
        }
      );
    }
    const reserved = await store.usageCounters.reserve(
      DRAFT_CEILING_SCOPE,
      day.start,
      limits.config.draftsPerDayCeiling,
      day.end + DAY
    );
    if (reserved === undefined) {
      throw new ToolError(
        'quota_exhausted',
        'The qus.me service has reached its limit of drafts for today across all users. ' +
          `Nothing was submitted. Retry after ${day.retryAfter} seconds (00:00 UTC).`,
        { scope: 'service', period: 'day', resets_at: day.end, retry_after: day.retryAfter }
      );
    }
    return async () => {
      await store.usageCounters.release(DRAFT_CEILING_SCOPE, day.start).catch(() => undefined);
    };
  }

  function toolSession(session: Session): ToolSession {
    const { agent } = session;
    const out: ToolSession = {
      now: session.now,
      currentGrant: async () => (await currentGrant(session)).grant,
      countSince: (start) => store.submissionReceipts.countSince(agent.agentKeyId, start),
      reserve: () => reserve(session),
      withAgentSigner: (fn) => custody.withAgentKey(agent.agentKeyId, fn),
      publisher,
      recordReceipt: async (receipt) => {
        await store.submissionReceipts.create({
          giftWrapId: receipt.giftWrapId,
          agentKeyId: agent.agentKeyId,
          queuePubkey: agent.queuePubkey,
          createdAt: receipt.createdAt,
          expiresAt: receipt.expiresAt,
        });
      },
      listReceipts: (page) =>
        store.submissionReceipts.listByAgentKey(agent.agentKeyId, session.now, page),
      maxPow,
      powMaxBytes,
      minerName: 'this qus.me service',
    };
    if (session.rateLimited !== undefined) out.rateLimited = session.rateLimited;
    return out;
  }

  function buildServer(session: Session): McpServer {
    const server = new McpServer(
      { name: 'qus.me', version: options.version },
      { instructions: QUSME_INSTRUCTIONS }
    );
    const tools = toolSession(session);
    registerQusmeTools(server, registry, () => tools);
    return server;
  }

  /** The `/mcp` handler; mount it after `requireBearer()`. */
  async function handle(c: Context<McpAuthEnv>): Promise<Response> {
    const agent = c.var.agent;
    const tier = await limits.tierFor(agent.queuePubkey);
    // The body is already capped by the app's size limit; read it once to see whether it calls a
    // tool, and hand the SDK a copy.
    const raw = c.req.raw;
    const hasBody = raw.method !== 'GET' && raw.method !== 'HEAD';
    const text = hasBody ? await raw.text() : '';
    const rate =
      (await limitedFor(limits, tier.mcpAgentRate, agent.agentPubkey)) ??
      (await limitedFor(limits, tier.mcpQueueRate, agent.queuePubkey));
    // Over the limit: a tool call gets a tool error the agent can read and act on; anything else
    // (initialize, tools/list) gets a plain 429.
    if (rate !== undefined && !callsTool(text)) {
      return tooManyRequests(
        c,
        rate,
        `too many requests from this agent or its queue; retry after ${rate} seconds`
      );
    }
    const session: Session = { agent, now: clock(), tier };
    if (rate !== undefined) session.rateLimited = rate;
    // 'auto' answers with one JSON body, since no tool emits anything before its result.
    const handler = createMcpHandler(() => buildServer(session), {
      maxRequestBodySize: MAX_REQUEST_BYTES,
    });
    const request = new Request(raw.url, {
      method: raw.method,
      headers: raw.headers,
      ...(hasBody ? { body: text } : {}),
    });
    return handler.fetch(request);
  }

  return { handle, grants, submitters, registry };
}

/** Seconds to wait if `key` is over `rateClass`, or undefined. */
async function limitedFor(
  limits: ServiceLimits,
  rateClass: TierLimits['mcpAgentRate'],
  key: string
): Promise<number | undefined> {
  const decision = await limits.limiter.limit(rateClass, key);
  return decision.ok ? undefined : decision.retryAfter;
}

export type Mcp = ReturnType<typeof createMcp>;

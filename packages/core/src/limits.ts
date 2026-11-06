/**
 * Rate limits, hard caps and tiers (spec 8.5, "Limits").
 *
 * Two kinds of limit, kept apart on purpose:
 *
 * - Rate limits slow abuse. They go through a {@link RateLimiter}: the Workers Rate Limiting
 *   binding on Workers (per Cloudflare location and eventually consistent, so approximate) and
 *   {@link createMemoryRateLimiter} on Node and in tests. Each {@link RATE_CLASSES} entry is one
 *   binding in `packages/entry-worker/wrangler.jsonc`, with the same limit and period (a test
 *   holds them together).
 * - Hard caps bound cost and fail closed. They count rows in D1 or SQLite (open pending
 *   authorizations, bindings per queue, receipts per queue per day) or reserve an exact counter
 *   (the service-wide daily create_draft ceiling), and any error while counting refuses the
 *   request.
 *
 * Limits that belong to a queue come from its tier ({@link TIERS}), resolved by queue pubkey
 * through an injectable {@link TierLookup}. Every queue is `free` until accounts (#39) can raise
 * one; a new tier is a new entry here plus, where its rates differ, new rate classes and bindings.
 */
import type { Context, MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';

/** A fixed window: at most `limit` calls per `period` seconds. Workers allows only 10 and 60. */
export interface RateRule {
  limit: number;
  period: 10 | 60;
}

/** A rate class: its rule and the Workers binding that enforces it there. */
export interface RateClass extends RateRule {
  binding: string;
}

/**
 * Every rate class. Per-IP classes cover the unauthenticated routes; the `_free` classes are the
 * free tier's per-agent and per-queue rates. Keys: the client IP, the agent pubkey or the queue
 * pubkey.
 */
export const RATE_CLASSES = {
  /** GET /authorize: starting an authorization, which may fetch a client metadata document. */
  ip_authorize: { limit: 10, period: 60, binding: 'RL_IP_AUTHORIZE' },
  /** GET /authorize/:id and its status poll; the waiting page polls every 2 s. */
  ip_poll: { limit: 60, period: 60, binding: 'RL_IP_POLL' },
  /** POST /token and POST /revoke. */
  ip_token: { limit: 20, period: 60, binding: 'RL_IP_TOKEN' },
  /** GET /pair/:code, the unauthenticated typed-code lookup (spec 8.3 step 3). */
  ip_pair: { limit: 10, period: 60, binding: 'RL_IP_PAIR' },
  /** /mcp requests per agent key. */
  mcp_agent_free: { limit: 30, period: 60, binding: 'RL_MCP_AGENT_FREE' },
  /** /mcp requests per queue, across all its agents. */
  mcp_queue_free: { limit: 60, period: 60, binding: 'RL_MCP_QUEUE_FREE' },
  /** NIP-98 device routes (/device/*, POST /pair) per queue key. */
  device_queue_free: { limit: 30, period: 60, binding: 'RL_DEVICE_QUEUE_FREE' },
} as const satisfies Record<string, RateClass>;

export type RateClassName = keyof typeof RATE_CLASSES;

/** What a queue's tier allows. */
export interface TierLimits {
  /** Agents (unrevoked bindings) one queue may have. */
  maxAgents: number;
  /** create_draft calls one queue may make per UTC day, on top of each grant's own quota. */
  draftsPerDay: number;
  /** Live typed pairing codes one queue key may hold (spec 8.3 step 2). */
  pairingCodes: number;
  /** Rate class for /mcp per agent key. */
  mcpAgentRate: RateClassName;
  /** Rate class for /mcp per queue. */
  mcpQueueRate: RateClassName;
  /** Rate class for the NIP-98 device routes per queue key. */
  deviceRate: RateClassName;
}

/** The tier table. One tier for now; `free` must always exist, as the fallback. */
export const TIERS = {
  free: {
    maxAgents: 10,
    draftsPerDay: 100,
    pairingCodes: 3,
    mcpAgentRate: 'mcp_agent_free',
    mcpQueueRate: 'mcp_queue_free',
    deviceRate: 'device_queue_free',
  },
} as const satisfies Record<string, TierLimits>;

export type TierTable = { free: TierLimits } & Record<string, TierLimits>;

/** The tier name for a queue pubkey. Always `free` until accounts (#39) exist. */
export type TierLookup = (queuePubkey: string) => string | Promise<string>;

/** Service-wide caps that do not depend on a queue's tier. */
export interface LimitsConfig {
  /** Undecided pending authorizations open at once from one client IP. */
  pendingPerIp: number;
  /** Undecided pending authorizations open at once across the service. */
  pendingGlobal: number;
  /**
   * create_draft calls the whole service accepts per UTC day, so a bug or abuse cannot exceed a
   * known cost. Configured per deployment (`QUSME_DAILY_DRAFT_CEILING`).
   */
  draftsPerDayCeiling: number;
}

export const DEFAULT_LIMITS: LimitsConfig = {
  pendingPerIp: 5,
  pendingGlobal: 500,
  draftsPerDayCeiling: 2000,
};

/** Largest request body per route family, in bytes. JSON is parsed only after this check. */
export const BODY_LIMITS = {
  /** A 32 KiB value (7.1), JSON-escaped, inside the JSON-RPC envelope. */
  mcp: 256 * 1024,
  /** Form-encoded token and revocation requests: a code, a verifier, a client id URL. */
  oauthForm: 8 * 1024,
  /** Everything else: device JSON bodies, POST /pair. */
  default: 4 * 1024,
} as const;

/** Longest request URL; /authorize carries the most (client id, redirect URI, state). */
export const MAX_URL_BYTES = 8 * 1024;

export type RateDecision = { ok: true } | { ok: false; retryAfter: number };

/** Counts one call against `key` in a rate class. */
export interface RateLimiter {
  limit(rateClass: RateClassName, key: string): Promise<RateDecision>;
}

/**
 * Fixed windows in memory. On Node it covers the one process; a restart forgets it. Retry-After
 * is the time left in the window.
 */
export function createMemoryRateLimiter(
  options: { now?: () => number; classes?: Record<string, RateRule> } = {}
): RateLimiter {
  const clock = options.now ?? (() => Math.floor(Date.now() / 1000));
  const classes: Record<string, RateRule> = options.classes ?? RATE_CLASSES;
  const windows = new Map<string, { start: number; count: number }>();
  return {
    async limit(rateClass, key) {
      const rule = classes[rateClass];
      if (rule === undefined) throw new Error(`unknown rate class ${rateClass}`);
      const now = clock();
      if (windows.size > 50_000) {
        for (const [k, w] of windows) if (now - w.start >= 60) windows.delete(k);
      }
      const id = `${rateClass}\u0000${key}`;
      const w = windows.get(id);
      if (w === undefined || now - w.start >= rule.period) {
        windows.set(id, { start: now, count: 1 });
        return rule.limit >= 1 ? { ok: true } : { ok: false, retryAfter: rule.period };
      }
      w.count += 1;
      if (w.count <= rule.limit) return { ok: true };
      return { ok: false, retryAfter: Math.max(1, w.start + rule.period - now) };
    },
  };
}

/** The Workers Rate Limiting binding's API. */
export interface RateLimitBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/** How {@link createBindingRateLimiter} falls back when a binding is missing or unusable. */
export interface BindingRateLimiterOptions {
  /** Rate classes; {@link RATE_CLASSES} by default. */
  classes?: Record<string, RateClass>;
  /**
   * Counts a class whose binding is missing or unusable. In memory by default; the Workers
   * entrypoint passes one per isolate, so its counts outlive a request.
   */
  fallback?: RateLimiter;
  /** Told the binding name, once per limiter, when a class falls back. Carries nothing else. */
  onUnavailable?: (binding: string) => void;
}

/**
 * The Workers Rate Limiting bindings, one per rate class, found in `env` by binding name. Each
 * class settles on first use: a binding that is missing, has no `limit` function or answers
 * without a boolean `success` is unavailable, and that class is counted by the fallback limiter
 * from then on, so an account or deploy without the binding still serves every request with
 * in-memory limits. The binding does not say when its window ends, so Retry-After is the class's
 * whole period. A binding call that throws is let through: the hard caps still bound cost, and an
 * outage of the limiter should not take the service down with it.
 */
export function createBindingRateLimiter(
  env: Record<string, unknown>,
  options: BindingRateLimiterOptions = {}
): RateLimiter {
  const classes = options.classes ?? RATE_CLASSES;
  const fallback = options.fallback ?? createMemoryRateLimiter({ classes });
  const unavailable = new Set<string>();
  const fallBack = (rateClass: RateClassName, key: string, binding: string) => {
    if (!unavailable.has(binding)) {
      unavailable.add(binding);
      options.onUnavailable?.(binding);
    }
    return fallback.limit(rateClass, key);
  };
  return {
    async limit(rateClass, key) {
      const rule = classes[rateClass];
      if (rule === undefined) throw new Error(`unknown rate class ${rateClass}`);
      if (unavailable.has(rule.binding)) return fallback.limit(rateClass, key);
      const binding = env[rule.binding] as Partial<RateLimitBinding> | null | undefined;
      if (typeof binding?.limit !== 'function') return fallBack(rateClass, key, rule.binding);
      let result: unknown;
      try {
        result = await binding.limit({ key });
      } catch {
        return { ok: true };
      }
      const success = (result as { success?: unknown } | null | undefined)?.success;
      if (typeof success !== 'boolean') return fallBack(rateClass, key, rule.binding);
      return success ? { ok: true } : { ok: false, retryAfter: rule.period };
    },
  };
}

/** What `createApp` takes to configure limits; everything has a default. */
export interface LimitsOptions {
  /** The rate limiter; in memory by default. Workers passes {@link createBindingRateLimiter}. */
  rateLimiter?: RateLimiter;
  /** Overrides of {@link DEFAULT_LIMITS}. */
  config?: Partial<LimitsConfig>;
  /** The tier table; {@link TIERS} by default. */
  tiers?: TierTable;
  /** The tier of a queue; always `free` by default. */
  tierLookup?: TierLookup;
  /**
   * The client's IP address. Defaults to `CF-Connecting-IP`, which Cloudflare sets on Workers and
   * on requests through a tunnel; a Node server reached another way shares one bucket.
   */
  clientIp?: (c: Context) => string;
  /** Unix seconds, for the default in-memory limiter's windows; tests pass a controlled clock. */
  now?: () => number;
}

/** The limits the app's routes consult, built once per app. */
export interface ServiceLimits {
  limiter: RateLimiter;
  config: LimitsConfig;
  /** The limits of a queue's tier; an unknown tier name falls back to `free`. */
  tierFor(queuePubkey: string): Promise<TierLimits>;
  clientIp(c: Context): string;
}

const defaultClientIp = (c: Context): string => c.req.header('CF-Connecting-IP') ?? 'unknown';

export function createServiceLimits(options: LimitsOptions = {}): ServiceLimits {
  const tiers: TierTable = options.tiers ?? TIERS;
  const lookup: TierLookup = options.tierLookup ?? (() => 'free');
  return {
    limiter:
      options.rateLimiter ??
      createMemoryRateLimiter(options.now === undefined ? {} : { now: options.now }),
    config: { ...DEFAULT_LIMITS, ...options.config },
    async tierFor(queuePubkey) {
      const name = await lookup(queuePubkey);
      return Object.hasOwn(tiers, name) ? (tiers[name] as TierLimits) : tiers.free;
    },
    clientIp: options.clientIp ?? defaultClientIp,
  };
}

/**
 * A non-negative integer limit from an environment variable, or `fallback` when unset. Throws on
 * anything else, so a mistyped limit stops the service instead of running without one.
 */
export function limitFromEnv(value: unknown, name: string, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const text = String(value).trim();
  if (!/^\d{1,9}$/.test(text)) throw new Error(`${name} must be a whole number, got ${text}`);
  return Number(text);
}

const DAY = 86_400;

/** The UTC day containing `now`: its start and the seconds until the next one. */
export function utcDay(now: number): { start: number; end: number; retryAfter: number } {
  const start = Math.floor(now / DAY) * DAY;
  return { start, end: start + DAY, retryAfter: Math.max(1, start + DAY - now) };
}

/** A 429 with Retry-After and a JSON body naming the error and the seconds to wait. */
export function tooManyRequests(
  c: Context,
  retryAfter: number,
  description: string,
  error = 'rate_limited'
): Response {
  const seconds = Math.max(1, Math.ceil(retryAfter));
  return c.json({ error, error_description: description, retry_after: seconds }, 429, {
    'Retry-After': String(seconds),
    'Cache-Control': 'no-store',
  });
}

/** Rate-limits a route by client IP. */
export function limitByIp(limits: ServiceLimits, rateClass: RateClassName): MiddlewareHandler {
  return async (c, next) => {
    const decision = await limits.limiter.limit(rateClass, limits.clientIp(c));
    if (!decision.ok) {
      return tooManyRequests(
        c,
        decision.retryAfter,
        `too many requests from this address; retry after ${decision.retryAfter} seconds`
      );
    }
    await next();
  };
}

/**
 * Rate-limits a NIP-98 route by the verified signer (the queue key) at its tier's device rate.
 * Mount it after the NIP-98 check.
 */
export function limitByQueue(limits: ServiceLimits): MiddlewareHandler<{
  Variables: { pubkey: string };
}> {
  return async (c, next) => {
    const pubkey = c.var.pubkey;
    const tier = await limits.tierFor(pubkey);
    const decision = await limits.limiter.limit(tier.deviceRate, pubkey);
    if (!decision.ok) {
      return tooManyRequests(
        c,
        decision.retryAfter,
        `too many requests for this queue; retry after ${decision.retryAfter} seconds`
      );
    }
    await next();
  };
}

/** The body cap for a path. */
export function bodyLimitFor(path: string): number {
  if (path === '/mcp') return BODY_LIMITS.mcp;
  if (path === '/token' || path === '/revoke') return BODY_LIMITS.oauthForm;
  return BODY_LIMITS.default;
}

/**
 * Caps every request: the URL at {@link MAX_URL_BYTES} (414) and the body at
 * {@link bodyLimitFor} its path (413), from Content-Length when sent and while streaming
 * otherwise, before any handler reads or parses it.
 */
export function requestSizeLimits(): MiddlewareHandler {
  const tooLarge = (c: Context) =>
    c.json({ error: 'payload_too_large', error_description: 'the request body is too large' }, 413);
  const byLimit = new Map<number, MiddlewareHandler>();
  for (const maxSize of new Set(Object.values(BODY_LIMITS))) {
    byLimit.set(maxSize, bodyLimit({ maxSize, onError: tooLarge }));
  }
  return async (c, next) => {
    if (new TextEncoder().encode(c.req.url).length > MAX_URL_BYTES) {
      return c.json(
        { error: 'uri_too_long', error_description: 'the request URL is too long' },
        414
      );
    }
    if (c.req.method === 'GET' || c.req.method === 'HEAD' || c.req.method === 'OPTIONS') {
      return next();
    }
    const handler = byLimit.get(bodyLimitFor(c.req.path)) as MiddlewareHandler;
    return handler(c, next);
  };
}

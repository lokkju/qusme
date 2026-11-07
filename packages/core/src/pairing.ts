import {
  generatePairingCode,
  normalizePairingCode,
  PAIRING_SESSION_TIMEOUT_MS,
  parsePairingUri,
} from '@qusme/nostr';
import type { Store } from '@qusme/store-sql';
import { Hono, type MiddlewareHandler } from 'hono';
import {
  BODY_LIMITS,
  createServiceLimits,
  limitByIp,
  limitByQueue,
  RATE_CLASSES,
  type ServiceLimits,
  TIERS,
  tooManyRequests,
} from './limits.ts';
import type { Nip98Env } from './nip98.ts';

/** A typed code lives no longer than the NIP-AB session it carries (spec 8.3 step 2). */
export const PAIRING_CODE_TTL_SECONDS = PAIRING_SESSION_TIMEOUT_MS / 1000;
/**
 * Live codes one queue key may hold on the free tier: NIP-AB recommends at most three concurrent
 * sessions. The tier table (`TIERS`) is the source.
 */
export const PAIRING_MAX_LIVE_PER_QUEUE = TIERS.free.pairingCodes;
/** Code lookups one client IP may make per window (spec 8.3 step 3): the `ip_pair` rate class. */
export const PAIRING_LOOKUPS_PER_WINDOW = RATE_CLASSES.ip_pair.limit;
export const PAIRING_LOOKUP_WINDOW_SECONDS = RATE_CLASSES.ip_pair.period;

const MAX_BODY = BODY_LIMITS.default;
const CODE_DRAWS = 5;

export interface PairingRoutesOptions {
  /** The service's pairing sessions table (spec 8.5). */
  sessions: Pick<Store['pairingSessions'], 'createIfFree' | 'countLive' | 'take'>;
  /** NIP-98 verification, the same middleware as the app's other signed routes. */
  requireNip98: MiddlewareHandler<Nip98Env>;
  /** Unix seconds; tests pass a fixed clock. */
  now?: () => number;
  /**
   * Rate limits and the queue's tier: lookups per client IP (`ip_pair`), signed posts per queue
   * key, and live codes per queue. In-memory defaults when left out.
   */
  limits?: ServiceLimits;
  /** Random bytes for codes; tests pass a fixed source. */
  random?: (n: number) => Uint8Array;
}

const noStore = { 'Cache-Control': 'no-store' };

/**
 * The typed-code rendezvous of spec 8.3, mounted at `/pair`:
 *
 * - `POST /pair`, NIP-98 signed by the queue key, body `{ "uri": "nostrpair://...",
 *   "expires_at"?: <unix seconds> }`: stores the URI under a fresh 8-character code and answers
 *   201 `{ "code", "expires_at" }`. The code expires with the NIP-AB session, at most 120 s from
 *   now and never after `expires_at`. A session that asked for a code is a typed-code session:
 *   the existing device calls `PairingSource.markTypedCode()` before posting and so sends the
 *   recovery backup.
 * - `GET /pair/:code`, unauthenticated: returns 200 `{ "uri", "expires_at" }` once and deletes
 *   the row in the same statement; an unknown, used or expired code is 404. Lookups are limited
 *   per client IP. The rate limit slows a guesser rather than bounding one (on Workers it is per
 *   Cloudflare location); the bound that matters is the code space, 40 bits against a 120-second
 *   life.
 *
 * The service stores the queue pubkey from NIP-98, the code, the URI and the expiry, nothing else.
 */
export function pairingRoutes(options: PairingRoutesOptions): Hono<Nip98Env> {
  const clock = options.now ?? (() => Math.floor(Date.now() / 1000));
  const limits = options.limits ?? createServiceLimits({ now: clock });
  const app = new Hono<Nip98Env>();

  app.post('/', options.requireNip98, limitByQueue(limits), async (c) => {
    const now = clock();
    const text = await c.req.text();
    if (text.length > MAX_BODY) return c.json({ error: 'body too large' }, 413);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return c.json({ error: 'body is not JSON' }, 400);
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return c.json({ error: 'body must be an object' }, 400);
    }
    const { uri, expires_at: requested } = body as Record<string, unknown>;
    const parsed = parsePairingUri(uri);
    if (!parsed.ok) return c.json({ error: `invalid uri: ${parsed.error.message}` }, 400);
    parsed.value.sessionSecret.fill(0);
    if (
      requested !== undefined &&
      (typeof requested !== 'number' || !Number.isSafeInteger(requested))
    ) {
      return c.json({ error: 'expires_at must be unix seconds' }, 400);
    }
    const expiresAt = Math.min(now + PAIRING_CODE_TTL_SECONDS, requested ?? Infinity);
    if (expiresAt <= now) return c.json({ error: 'the session has already expired' }, 400);

    const queuePubkey = c.var.pubkey;
    const tier = await limits.tierFor(queuePubkey);
    if ((await options.sessions.countLive(queuePubkey, now)) >= tier.pairingCodes) {
      return tooManyRequests(
        c,
        PAIRING_CODE_TTL_SECONDS,
        'too many open pairing sessions',
        'too_many_pairing_sessions'
      );
    }
    for (let draw = 0; draw < CODE_DRAWS; draw++) {
      const code = generatePairingCode(options.random);
      const row = await options.sessions.createIfFree(
        { code, queuePubkey, uri: uri as string, createdAt: now, expiresAt },
        now
      );
      if (row !== undefined) {
        return c.json({ code, expires_at: expiresAt }, 201, noStore);
      }
    }
    return c.json({ error: 'no free code; try again' }, 503);
  });

  app.get('/:code', limitByIp(limits, 'ip_pair'), async (c) => {
    const now = clock();
    const code = normalizePairingCode(c.req.param('code'));
    if (code === undefined) return c.json({ error: 'not a pairing code' }, 400);
    const row = await options.sessions.take(code, now);
    if (row === undefined) return c.json({ error: 'unknown or expired code' }, 404, noStore);
    return c.json({ uri: row.uri, expires_at: row.expiresAt }, 200, noStore);
  });

  return app;
}

import {
  generatePairingCode,
  normalizePairingCode,
  PAIRING_SESSION_TIMEOUT_MS,
  parsePairingUri,
} from '@qusme/nostr';
import type { Store } from '@qusme/store-sql';
import { type Context, Hono, type MiddlewareHandler } from 'hono';
import type { Nip98Env } from './nip98.ts';

/** A typed code lives no longer than the NIP-AB session it carries (spec 8.3 step 2). */
export const PAIRING_CODE_TTL_SECONDS = PAIRING_SESSION_TIMEOUT_MS / 1000;
/** Live codes one queue key may hold: NIP-AB recommends at most three concurrent sessions. */
export const PAIRING_MAX_LIVE_PER_QUEUE = 3;
/** Code lookups one client may make per window (spec 8.3 step 3). */
export const PAIRING_LOOKUPS_PER_WINDOW = 10;
export const PAIRING_LOOKUP_WINDOW_SECONDS = 60;

const MAX_BODY = 4096;
const CODE_DRAWS = 5;

export interface PairingRoutesOptions {
  /** The service's pairing sessions table (spec 8.5). */
  sessions: Pick<Store['pairingSessions'], 'createIfFree' | 'countLive' | 'take'>;
  /** NIP-98 verification, the same middleware as the app's other signed routes. */
  requireNip98: MiddlewareHandler<Nip98Env>;
  /** Unix seconds; tests pass a fixed clock. */
  now?: () => number;
  /**
   * Who is asking, for the per-client lookup limit. Defaults to `CF-Connecting-IP`, which
   * Cloudflare sets on Workers and on requests through the tunnel; anything that reaches the Node
   * server another way shares one bucket.
   */
  clientKey?: (c: Context) => string;
  /** Lookups per client per window; defaults to {@link PAIRING_LOOKUPS_PER_WINDOW}. */
  lookupsPerWindow?: number;
  /** Random bytes for codes; tests pass a fixed source. */
  random?: (n: number) => Uint8Array;
}

const defaultClientKey = (c: Context): string => c.req.header('CF-Connecting-IP') ?? 'unknown';

/**
 * A fixed-window counter per client, in memory. On Node it covers the one process; on Workers
 * each isolate keeps its own, so it slows a guesser rather than bounding one. The bound that
 * matters is the code space: 40 bits against a 120-second life.
 */
function lookupLimiter(limit: number, windowSeconds: number) {
  const windows = new Map<string, { start: number; count: number }>();
  return (key: string, now: number): number | undefined => {
    if (windows.size > 10_000) {
      for (const [k, w] of windows) if (now - w.start >= windowSeconds) windows.delete(k);
    }
    const w = windows.get(key);
    if (w === undefined || now - w.start >= windowSeconds) {
      windows.set(key, { start: now, count: 1 });
      return undefined;
    }
    w.count += 1;
    return w.count > limit ? w.start + windowSeconds - now : undefined;
  };
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
 *   per client.
 *
 * The service stores the queue pubkey from NIP-98, the code, the URI and the expiry, nothing else.
 */
export function pairingRoutes(options: PairingRoutesOptions): Hono<Nip98Env> {
  const clock = options.now ?? (() => Math.floor(Date.now() / 1000));
  const clientKey = options.clientKey ?? defaultClientKey;
  const limited = lookupLimiter(
    options.lookupsPerWindow ?? PAIRING_LOOKUPS_PER_WINDOW,
    PAIRING_LOOKUP_WINDOW_SECONDS
  );
  const app = new Hono<Nip98Env>();

  app.post('/', options.requireNip98, async (c) => {
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
    if ((await options.sessions.countLive(queuePubkey, now)) >= PAIRING_MAX_LIVE_PER_QUEUE) {
      return c.json({ error: 'too many open pairing sessions' }, 429, {
        'Retry-After': String(PAIRING_CODE_TTL_SECONDS),
      });
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

  app.get('/:code', async (c) => {
    const now = clock();
    const retryAfter = limited(clientKey(c), now);
    if (retryAfter !== undefined) {
      return c.json({ error: 'too many attempts' }, 429, { 'Retry-After': String(retryAfter) });
    }
    const code = normalizePairingCode(c.req.param('code'));
    if (code === undefined) return c.json({ error: 'not a pairing code' }, 400);
    const row = await options.sessions.take(code, now);
    if (row === undefined) return c.json({ error: 'unknown or expired code' }, 404, noStore);
    return c.json({ uri: row.uri, expires_at: row.expiresAt }, 200, noStore);
  });

  return app;
}

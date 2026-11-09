import { HTTP_AUTH_WINDOW_SECONDS, type HttpAuth, verifyHttpAuth } from '@qusme/nostr';
import type { Store } from '@qusme/store-sql';
import type { Context, MiddlewareHandler } from 'hono';
import { createMiddleware } from 'hono/factory';

/** The context variables {@link nip98Auth} sets, for handlers mounted behind it. */
export interface Nip98Env {
  Variables: {
    /** The pubkey that signed the request: the queue pubkey for a device (spec 5). */
    pubkey: string;
    /** The verified auth event's id and `created_at`, with the pubkey. */
    nip98: HttpAuth;
  };
}

export interface Nip98Options {
  /**
   * The origin clients reach the service at, such as `https://app.qus.me`. The URL a request was
   * signed for is this origin plus the request's path and query. Scheme and host never come from
   * the request: a Node server behind a reverse proxy sees neither, and
   * forwarded headers are whatever the last hop chose to send.
   */
  publicOrigin: string;
  /** Where seen event ids are held until the window passes (spec 8.5). */
  replays: Pick<Store['nip98Replays'], 'remember'>;
  /** Unix seconds; tests pass a fixed clock. */
  now?: () => number;
  /** How far `created_at` may be from now, either way. NIP-98's 60 s unless a test changes it. */
  windowSeconds?: number;
}

/** Checks that `origin` is a bare http(s) origin and returns it in canonical form. */
export function parsePublicOrigin(origin: string): string {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new Error(`public origin is not a URL: ${origin}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`public origin must be http or https: ${origin}`);
  }
  if (url.origin !== origin.replace(/\/$/, '')) {
    throw new Error(`public origin must be scheme and host only: ${origin}`);
  }
  return url.origin;
}

/** The absolute URL a client signed for this request: the public origin, path and query. */
export function signedUrl(publicOrigin: string, requestUrl: string): string {
  const url = new URL(requestUrl);
  return publicOrigin + url.href.slice(url.origin.length);
}

const unauthorized = (c: Context, reason: string) =>
  c.json({ error: 'unauthorized', reason }, 401, { 'WWW-Authenticate': 'Nostr' });

/**
 * Hono middleware requiring a NIP-98 `Authorization: Nostr <base64 event>` header (spec 5, 8.2,
 * 8.3, 6.1). It verifies the event against the URL as served at the public origin, the method, and
 * the SHA-256 of the raw body, then records the event id so the same header is refused for as
 * long as it would otherwise verify. Handlers read the pubkey from `c.var.pubkey`.
 *
 * The body is read from a clone of the request, so `c.req.json()`, `c.req.text()` and
 * `c.req.raw` all still work downstream. Failures are 401 with `WWW-Authenticate: Nostr` and a
 * short reason. Whether that pubkey may do what it asks is the handler's decision.
 */
export function nip98Auth(options: Nip98Options): MiddlewareHandler<Nip98Env> {
  const origin = parsePublicOrigin(options.publicOrigin);
  const window = options.windowSeconds ?? HTTP_AUTH_WINDOW_SECONDS;
  const clock = options.now ?? (() => Math.floor(Date.now() / 1000));

  return createMiddleware<Nip98Env>(async (c, next) => {
    const header = c.req.header('Authorization');
    if (header === undefined) return unauthorized(c, 'missing Authorization header');

    const method = c.req.method;
    const body =
      method === 'GET' || method === 'HEAD' || c.req.raw.body === null
        ? undefined
        : new Uint8Array(await c.req.raw.clone().arrayBuffer());

    const now = clock();
    const result = verifyHttpAuth(
      header,
      { url: signedUrl(origin, c.req.url), method, body },
      { now, windowSeconds: window }
    );
    if (!result.ok) return unauthorized(c, result.error.message);

    // Valid while |now - created_at| <= window, so held until one second past the far edge.
    const auth = result.value;
    if (!(await options.replays.remember(auth.eventId, auth.createdAt + window + 1, now))) {
      return unauthorized(c, 'event already used');
    }

    c.set('pubkey', auth.pubkey);
    c.set('nip98', auth);
    await next();
  });
}

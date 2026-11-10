import {
  agentKeyRingFromEnv,
  bundledRegistry,
  createAgentKeyCustody,
  createApp,
  createBindingRateLimiter,
  createMemoryRateLimiter,
  DEFAULT_LIMITS,
  DEFAULT_MAX_POW,
  limitFromEnv,
  type RateLimitBinding,
} from '@qusme/core';
import { createStore } from '@qusme/store-sql';
import { openD1 } from '@qusme/store-sql/d1';
import snapshot from '../../../registry/snapshot.json' with { type: 'json' };

/**
 * Bindings and secrets. DB and QUSME_AGENT_KEY_SECRET are provisioned by Pulumi in lokkju/infra,
 * as are QUSME_AGENT_KEY_VERSION and QUSME_AGENT_KEY_SECRET_PREVIOUS while the secret rotates.
 */
export interface Env {
  DB: D1Database;
  QUSME_AGENT_KEY_SECRET: string;
  /** The origin clients sign NIP-98 requests for; a plain var in wrangler.jsonc. */
  QUSME_PUBLIC_ORIGIN: string;
  /** The current secret's version; 1 when unset. */
  QUSME_AGENT_KEY_VERSION?: string;
  /** The secret of the version before it, only during a rotation. */
  QUSME_AGENT_KEY_SECRET_PREVIOUS?: string;
  /**
   * The landing site's origin (https://qus.me); a plain var in wrangler.jsonc. Requests for its
   * host, or for www. in front of it, get the static site; unset, no host serves the site.
   */
  QUSME_SITE_ORIGIN?: string;
  /** The static assets binding over `site/` (wrangler.jsonc `assets`). */
  ASSETS?: Fetcher;
  /** The service-wide daily create_draft ceiling; a plain var in wrangler.jsonc. */
  QUSME_DAILY_DRAFT_CEILING?: string;
  /**
   * The most NIP-13 proof of work create_draft mines for a grant's min_pow, in bits (spec 7.4); a
   * plain var in wrangler.jsonc, sized to the plan's CPU limit per request.
   */
  QUSME_MAX_POW?: string;
  /**
   * The Workers Rate Limiting bindings in wrangler.jsonc, one per rate class (RATE_CLASSES).
   * Optional: a class whose binding is missing or unusable is counted in memory in this isolate.
   */
  RL_IP_AUTHORIZE?: RateLimitBinding;
  RL_IP_POLL?: RateLimitBinding;
  RL_IP_TOKEN?: RateLimitBinding;
  RL_IP_PAIR?: RateLimitBinding;
  RL_MCP_AGENT_FREE?: RateLimitBinding;
  RL_MCP_QUEUE_FREE?: RateLimitBinding;
  RL_DEVICE_QUEUE_FREE?: RateLimitBinding;
}

/** Set at build time through wrangler's `define` (the commit, in deploy.yml). */
declare const __QUSME_VERSION__: string;

// The bundled registry's verified definitions, read once per isolate; a definition that fails
// verification is dropped with a log line.
const registry = bundledRegistry(snapshot, { log: (line) => console.warn(line) });

// Rate limits for classes whose binding is missing or unusable (an account or deploy without
// Workers Rate Limiting): counted in memory for the life of this isolate, with one warning per
// binding per isolate. The hard caps in D1 stay fail-closed either way.
const fallbackLimiter = createMemoryRateLimiter();
const warnedBindings = new Set<string>();
const bindingUnavailable = (binding: string) => {
  if (warnedBindings.has(binding)) return;
  warnedBindings.add(binding);
  console.warn(`ratelimit_binding_unavailable name=${binding}`);
};

/**
 * Headers on every landing site response. The site is static HTML, one stylesheet, self-hosted
 * fonts and one script file, so the CSP allows only same-origin styles, fonts, images and scripts
 * and nothing inline.
 */
export const SITE_HEADERS: Readonly<Record<string, string>> = {
  'Content-Security-Policy': [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "font-src 'self'",
    "img-src 'self'",
    "connect-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; '),
  'Strict-Transport-Security': 'max-age=31536000',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
};

const hostOf = (origin: string | undefined): string | undefined => {
  if (!origin) return undefined;
  try {
    return new URL(origin).host;
  } catch {
    return undefined;
  }
};

/** Serves the landing site from the assets binding, with the site's security headers. */
async function serveSite(request: Request, assets: Fetcher): Promise<Response> {
  const asset = await assets.fetch(request);
  const response = new Response(asset.body, asset);
  for (const [name, value] of Object.entries(SITE_HEADERS)) response.headers.set(name, value);
  return response;
}

const notFound = () =>
  new Response('Not found\n', { status: 404, headers: { 'Content-Type': 'text/plain' } });

/** The qus.me service (packages/core) for one request. */
function serveApi(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
  const app = createApp({
    version: __QUSME_VERSION__,
    db: openD1(env.DB),
    agentKeys: agentKeyRingFromEnv({ ...env }),
    publicOrigin: env.QUSME_PUBLIC_ORIGIN,
    // A ceiling that is not a whole number throws, so a misconfigured deploy refuses requests
    // instead of running without its cost bound.
    limits: {
      rateLimiter: createBindingRateLimiter(
        { ...env },
        { fallback: fallbackLimiter, onUnavailable: bindingUnavailable }
      ),
      config: {
        draftsPerDayCeiling: limitFromEnv(
          env.QUSME_DAILY_DRAFT_CEILING,
          'QUSME_DAILY_DRAFT_CEILING',
          DEFAULT_LIMITS.draftsPerDayCeiling
        ),
      },
    },
    mcp: {
      registry,
      // Like the ceiling, a value that is not a whole number from 0 to 256 refuses requests.
      maxPow: limitFromEnv(env.QUSME_MAX_POW, 'QUSME_MAX_POW', DEFAULT_MAX_POW),
      // Pubkeys only (spec 8.4): a tool went ahead on the grant without the submitters list.
      notice: (n) => console.warn(`${n.event} agent=${n.agentPubkey} queue=${n.queuePubkey}`),
    },
  });
  return app.fetch(request, env, ctx);
}

export default {
  // Routes by Host: the service's origin (QUSME_PUBLIC_ORIGIN, app.qus.me) gets the API exactly as
  // before, the site's origin (QUSME_SITE_ORIGIN, qus.me) gets the static site, www. in front of
  // it redirects there, and any other host gets a 404. The site never answers on app.qus.me and the
  // API never answers on qus.me. wrangler.jsonc sets assets.run_worker_first, so every request
  // comes through here, assets included.
  fetch(request, env, ctx) {
    const host = new URL(request.url).host;
    if (host === hostOf(env.QUSME_PUBLIC_ORIGIN)) return serveApi(request, env, ctx);
    const siteHost = hostOf(env.QUSME_SITE_ORIGIN);
    if (siteHost !== undefined && host === siteHost) {
      return env.ASSETS ? serveSite(request, env.ASSETS) : notFound();
    }
    if (siteHost !== undefined && host === `www.${siteHost}`) {
      const url = new URL(request.url);
      return Response.redirect(new URL(url.pathname + url.search, env.QUSME_SITE_ORIGIN).href, 301);
    }
    return notFound();
  },

  // The cron trigger in wrangler.jsonc: delete expired service state (spec 8.5) and, while the
  // previous agent key secret is set, re-encrypt one batch of agent keys under the current one.
  async scheduled(controller, env) {
    const store = createStore(openD1(env.DB));
    await store.sweepExpired(Math.floor(controller.scheduledTime / 1000));
    const ring = agentKeyRingFromEnv({ ...env });
    if (ring.rotating) {
      const result = await createAgentKeyCustody(store, ring).rotate();
      if (result.failed.length > 0) {
        console.error('agent key rotation left keys behind', result.failed);
      }
    }
  },
} satisfies ExportedHandler<Env>;

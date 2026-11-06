import { createStore, type QusmeDb } from '@qusme/store-sql';
import { Hono } from 'hono';
import type { AgentKeyRing } from './agentKeyRing.ts';
import { createServiceLimits, type LimitsOptions, requestSizeLimits } from './limits.ts';
import { createMcp, type McpOverrides } from './mcp/server.ts';
import { nip98Auth } from './nip98.ts';
import { createWebSocketRelayReader } from './oauth/relayReader.ts';
import { createOAuth, type OAuthOverrides } from './oauth/server.ts';
import { pairingRoutes } from './pairing.ts';

/**
 * What an entrypoint hands the app. Everything runtime-specific (the database driver, secrets,
 * the build's version) comes in here, so the app itself uses only Web-standard APIs and runs
 * unchanged on Workers and Node (spec 8.5).
 */
export interface AppDeps {
  /** The build's version, reported by GET /healthz. */
  version: string;
  /** The service's own state (spec 8.5): D1 on Workers, a SQLite file on Node. */
  db: QusmeDb;
  /**
   * The service secrets that encrypt agent keys at rest (spec 6.2), from `agentKeyRingFromEnv`.
   * Routes take custody with `createAgentKeyCustody(createStore(db), agentKeys)`.
   */
  agentKeys: AgentKeyRing;
  /**
   * The origin clients sign NIP-98 requests for, `https://app.qus.me` in production. Configured,
   * never read from the request or forwarded headers.
   */
  publicOrigin: string;
  /**
   * Rate limits, hard caps and tiers (spec 8.5, "Limits"): the rate limiter (the Workers binding
   * there, in memory by default), cap overrides such as the daily draft ceiling, the tier table and
   * tier lookup, and how to read the client IP.
   */
  limits?: LimitsOptions;
  /** Test and entrypoint overrides for the OAuth server: fetch, relay reader, clock, lifetimes. */
  oauth?: OAuthOverrides;
  /**
   * Test and entrypoint overrides for the MCP tools: registry snapshot, relay reader and
   * publisher, clock, grant cache lifetime. The relay reader and clock default to the OAuth ones.
   */
  mcp?: McpOverrides;
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  const now = deps.mcp?.now ?? deps.oauth?.now;
  const limits = createServiceLimits({
    ...(now !== undefined && { now }),
    ...deps.limits,
  });
  // Every route: URL and body size caps, checked before any handler reads or parses the body.
  app.use('*', requestSizeLimits());
  const requireNip98 = nip98Auth({
    publicOrigin: deps.publicOrigin,
    replays: createStore(deps.db).nip98Replays,
  });

  app.get('/healthz', (c) => c.json({ ok: true, version: deps.version }));

  // OAuth 2.1 for MCP clients and the device-side approval API (spec 8.2).
  const relayReader = deps.oauth?.relayReader ?? createWebSocketRelayReader();
  const oauth = createOAuth({
    ...deps.oauth,
    relayReader,
    db: deps.db,
    agentKeys: deps.agentKeys,
    publicOrigin: deps.publicOrigin,
    limits,
  });
  app.route('/', oauth.routes);

  // Stateless streamable HTTP MCP endpoint (spec 8.4) behind the bearer check.
  const mcpOverrides: McpOverrides = { ...deps.mcp };
  if (now !== undefined) mcpOverrides.now = now;
  const mcp = createMcp({
    relayReader,
    ...mcpOverrides,
    db: deps.db,
    agentKeys: deps.agentKeys,
    version: deps.version,
    limits,
  });
  app.use('/mcp', oauth.mcpCors);
  app.all('/mcp', oauth.requireBearer(), (c) => mcp.handle(c));

  // Typed-code pairing rendezvous (spec 8.3 steps 2 and 3).
  app.route(
    '/pair',
    pairingRoutes({ sessions: createStore(deps.db).pairingSessions, requireNip98, limits })
  );
  app.post('/rotate', requireNip98, (c) => c.json({ error: 'not implemented' }, 501));

  return app;
}

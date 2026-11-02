import { createStore, type QusmeDb } from '@qusme/store-sql';
import { Hono } from 'hono';
import type { AgentKeyRing } from './agentKeyRing.ts';
import { nip98Auth } from './nip98.ts';
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
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  const requireNip98 = nip98Auth({
    publicOrigin: deps.publicOrigin,
    replays: createStore(deps.db).nip98Replays,
  });

  app.get('/healthz', (c) => c.json({ ok: true, version: deps.version }));

  // Streamable HTTP MCP endpoint (spec 8.4); not implemented yet.
  app.all('/mcp', (c) => c.json({ error: 'not implemented' }, 501));

  // Typed-code pairing rendezvous (spec 8.3 steps 2 and 3).
  app.route(
    '/pair',
    pairingRoutes({ sessions: createStore(deps.db).pairingSessions, requireNip98 })
  );
  app.post('/rotate', requireNip98, (c) => c.json({ error: 'not implemented' }, 501));

  return app;
}

import type { QusmeDb } from '@qusme/store-sql';
import { Hono } from 'hono';

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
  /** Encrypts agent keys at rest (spec 6.2). Unused until agent key custody lands. */
  agentKeySecret: string;
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();

  app.get('/healthz', (c) => c.json({ ok: true, version: deps.version }));

  // Streamable HTTP MCP endpoint (spec 8.4); not implemented yet.
  app.all('/mcp', (c) => c.json({ error: 'not implemented' }, 501));

  return app;
}

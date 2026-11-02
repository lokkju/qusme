import {
  type AgentKeyRing,
  agentKeyRingFromEnv,
  createAgentKeyCustody,
  createApp,
} from '@qusme/core';
import { createStore } from '@qusme/store-sql';
import { openSqlite } from '@qusme/store-sql/sqlite';

export interface NodeConfig {
  /** SQLite file for the service's state; ':memory:' for tests. */
  dbPath: string;
  /** QUSME_AGENT_KEY_SECRET, and while rotating QUSME_AGENT_KEY_VERSION and _SECRET_PREVIOUS. */
  agentKeys: AgentKeyRing;
  version: string;
  /** The origin clients sign NIP-98 requests for (spec 8.5); never taken from request headers. */
  publicOrigin: string;
}

/** Where the service is served in production, behind the Cloudflare tunnel and Traefik. */
export const DEFAULT_PUBLIC_ORIGIN = 'https://app.qus.me';

/** How often the Node entrypoint sweeps expired service state, as the Workers cron does. */
export const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Reads the Node entrypoint's settings from the environment. Throws, so the server refuses to
 * start, if QUSME_AGENT_KEY_SECRET is missing or not base64 of 32 bytes.
 */
export function configFromEnv(env: NodeJS.ProcessEnv): NodeConfig {
  return {
    dbPath: env.QUSME_DB_PATH ?? './qusme.db',
    agentKeys: agentKeyRingFromEnv(env),
    // Baked into the image at build time (the Dockerfile's QUSME_VERSION build argument).
    version: env.QUSME_VERSION ?? 'dev',
    publicOrigin: env.QUSME_PUBLIC_ORIGIN ?? DEFAULT_PUBLIC_ORIGIN,
  };
}

/**
 * The app over a migrated SQLite file, a sweep of that file's expired state, and a re-encryption
 * pass that moves agent keys to the current secret version (a no-op unless one is below it).
 */
export function buildApp(config: NodeConfig) {
  const db = openSqlite(config.dbPath);
  const store = createStore(db);
  const app = createApp({
    version: config.version,
    db,
    agentKeys: config.agentKeys,
    publicOrigin: config.publicOrigin,
  });
  const sweep = () => store.sweepExpired(Math.floor(Date.now() / 1000));
  const rotateAgentKeys = () => createAgentKeyCustody(store, config.agentKeys).rotate();
  return Object.assign(app, { sweep, rotateAgentKeys });
}

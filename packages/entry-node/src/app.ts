import { createApp } from '@qusme/core';
import { createStore } from '@qusme/store-sql';
import { openSqlite } from '@qusme/store-sql/sqlite';

export interface NodeConfig {
  /** SQLite file for the service's state; ':memory:' for tests. */
  dbPath: string;
  agentKeySecret: string;
  version: string;
}

/** How often the Node entrypoint sweeps expired service state, as the Workers cron does. */
export const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

/** Reads the Node entrypoint's settings from the environment. */
export function configFromEnv(env: NodeJS.ProcessEnv): NodeConfig {
  const agentKeySecret = env.QUSME_AGENT_KEY_SECRET;
  if (!agentKeySecret) {
    throw new Error('QUSME_AGENT_KEY_SECRET is not set');
  }
  return {
    dbPath: env.QUSME_DB_PATH ?? './qusme.db',
    agentKeySecret,
    // Baked into the image at build time (the Dockerfile's QUSME_VERSION build argument).
    version: env.QUSME_VERSION ?? 'dev',
  };
}

/** The app over a migrated SQLite file, and a sweep of that file's expired state. */
export function buildApp(config: NodeConfig) {
  const db = openSqlite(config.dbPath);
  const store = createStore(db);
  const app = createApp({
    version: config.version,
    db,
    agentKeySecret: config.agentKeySecret,
  });
  const sweep = () => store.sweepExpired(Math.floor(Date.now() / 1000));
  return Object.assign(app, { sweep });
}

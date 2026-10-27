import { createApp } from '@qusme/core';
import { openSqlite } from '@qusme/store-sql/sqlite';

export interface NodeConfig {
  /** SQLite file for the service's state; ':memory:' for tests. */
  dbPath: string;
  agentKeySecret: string;
  version: string;
}

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

export function buildApp(config: NodeConfig) {
  return createApp({
    version: config.version,
    db: openSqlite(config.dbPath),
    agentKeySecret: config.agentKeySecret,
  });
}

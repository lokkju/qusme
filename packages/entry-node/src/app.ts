import {
  type AgentKeyRing,
  agentKeyRingFromEnv,
  bundledRegistry,
  createAgentKeyCustody,
  createApp,
  DEFAULT_LIMITS,
  limitFromEnv,
} from '@qusme/core';
import { createStore } from '@qusme/store-sql';
import { openSqlite } from '@qusme/store-sql/sqlite';
import snapshot from '../../../registry/snapshot.json' with { type: 'json' };

export interface NodeConfig {
  /** SQLite file for the service's state; ':memory:' for tests. */
  dbPath: string;
  /** QUSME_AGENT_KEY_SECRET, and while rotating QUSME_AGENT_KEY_VERSION and _SECRET_PREVIOUS. */
  agentKeys: AgentKeyRing;
  version: string;
  /** The origin clients sign NIP-98 requests for (spec 8.5); never taken from request headers. */
  publicOrigin: string;
  /** The service-wide daily create_draft ceiling (spec 8.5, "Limits"). */
  draftsPerDayCeiling: number;
  /**
   * Tests only: a registry snapshot and the key to pin for it, in place of the bundled
   * `registry/snapshot.json` and the production publisher key. Never read from the environment.
   */
  registry?: { snapshot: unknown; publisher: string };
}

/** Where the service is served in production, behind the Cloudflare tunnel and Traefik. */
export const DEFAULT_PUBLIC_ORIGIN = 'https://app.qus.me';

/** How often the Node entrypoint sweeps expired service state, as the Workers cron does. */
export const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Reads the Node entrypoint's settings from the environment. Throws, so the server refuses to
 * start, if QUSME_AGENT_KEY_SECRET is missing or not base64 of 32 bytes, or if
 * QUSME_DAILY_DRAFT_CEILING is set to anything but a whole number.
 */
export function configFromEnv(env: NodeJS.ProcessEnv): NodeConfig {
  return {
    dbPath: env.QUSME_DB_PATH ?? './qusme.db',
    agentKeys: agentKeyRingFromEnv(env),
    // Baked into the image at build time (the Dockerfile's QUSME_VERSION build argument).
    version: env.QUSME_VERSION ?? 'dev',
    publicOrigin: env.QUSME_PUBLIC_ORIGIN ?? DEFAULT_PUBLIC_ORIGIN,
    draftsPerDayCeiling: limitFromEnv(
      env.QUSME_DAILY_DRAFT_CEILING,
      'QUSME_DAILY_DRAFT_CEILING',
      DEFAULT_LIMITS.draftsPerDayCeiling
    ),
  };
}

/**
 * The app over a migrated SQLite file, a sweep of that file's expired state, and a re-encryption
 * pass that moves agent keys to the current secret version (a no-op unless one is below it). The
 * MCP tools get the bundled registry's verified definitions; a definition that fails
 * verification is dropped with a log line.
 */
export function buildApp(config: NodeConfig, log: (line: string) => void = console.warn) {
  const db = openSqlite(config.dbPath);
  const store = createStore(db);
  const registry = bundledRegistry(config.registry?.snapshot ?? snapshot, {
    ...(config.registry && { publisher: config.registry.publisher }),
    log,
  });
  const app = createApp({
    version: config.version,
    db,
    agentKeys: config.agentKeys,
    publicOrigin: config.publicOrigin,
    // Rate limits in memory for this one process; the caps are counted in the SQLite file.
    limits: { config: { draftsPerDayCeiling: config.draftsPerDayCeiling } },
    mcp: {
      registry,
      // Pubkeys only (spec 8.4): a tool went ahead on the grant without the submitters list.
      notice: (n) => log(`${n.event} agent=${n.agentPubkey} queue=${n.queuePubkey}`),
    },
  });
  const sweep = () => store.sweepExpired(Math.floor(Date.now() / 1000));
  const rotateAgentKeys = () => createAgentKeyCustody(store, config.agentKeys).rotate();
  return Object.assign(app, { sweep, rotateAgentKeys, registry });
}

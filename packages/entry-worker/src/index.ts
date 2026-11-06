import {
  agentKeyRingFromEnv,
  bundledRegistry,
  createAgentKeyCustody,
  createApp,
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
}

/** Set at build time through wrangler's `define` (the commit, in deploy.yml). */
declare const __QUSME_VERSION__: string;

// The bundled registry's verified definitions, read once per isolate; a definition that fails
// verification is dropped with a log line.
const registry = bundledRegistry(snapshot, { log: (line) => console.warn(line) });

export default {
  fetch(request, env, ctx) {
    const app = createApp({
      version: __QUSME_VERSION__,
      db: openD1(env.DB),
      agentKeys: agentKeyRingFromEnv({ ...env }),
      publicOrigin: env.QUSME_PUBLIC_ORIGIN,
      mcp: {
        registry,
        // Pubkeys only (spec 8.4): a tool went ahead on the grant without the submitters list.
        notice: (n) => console.warn(`${n.event} agent=${n.agentPubkey} queue=${n.queuePubkey}`),
      },
    });
    return app.fetch(request, env, ctx);
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

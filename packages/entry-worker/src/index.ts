import { createApp } from '@qusme/core';
import { createStore } from '@qusme/store-sql';
import { openD1 } from '@qusme/store-sql/d1';

/** Bindings and secrets. DB and QUSME_AGENT_KEY_SECRET are provisioned by Pulumi in lokkju/infra. */
export interface Env {
  DB: D1Database;
  QUSME_AGENT_KEY_SECRET: string;
  /** The origin clients sign NIP-98 requests for; a plain var in wrangler.jsonc. */
  QUSME_PUBLIC_ORIGIN: string;
}

/** Set at build time through wrangler's `define` (the commit, in deploy.yml). */
declare const __QUSME_VERSION__: string;

export default {
  fetch(request, env, ctx) {
    const app = createApp({
      version: __QUSME_VERSION__,
      db: openD1(env.DB),
      agentKeySecret: env.QUSME_AGENT_KEY_SECRET,
      publicOrigin: env.QUSME_PUBLIC_ORIGIN,
    });
    return app.fetch(request, env, ctx);
  },

  // The cron trigger in wrangler.jsonc: delete expired service state (spec 8.5).
  async scheduled(controller, env) {
    await createStore(openD1(env.DB)).sweepExpired(Math.floor(controller.scheduledTime / 1000));
  },
} satisfies ExportedHandler<Env>;

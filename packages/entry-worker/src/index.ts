import { createApp } from '@qusme/core';
import { openD1 } from '@qusme/store-sql/d1';

/** Bindings and secrets. DB and QUSME_AGENT_KEY_SECRET are provisioned by Pulumi in lokkju/infra. */
export interface Env {
  DB: D1Database;
  QUSME_AGENT_KEY_SECRET: string;
}

/** Set at build time through wrangler's `define` (the commit, in deploy.yml). */
declare const __QUSME_VERSION__: string;

export default {
  fetch(request, env, ctx) {
    const app = createApp({
      version: __QUSME_VERSION__,
      db: openD1(env.DB),
      agentKeySecret: env.QUSME_AGENT_KEY_SECRET,
    });
    return app.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;

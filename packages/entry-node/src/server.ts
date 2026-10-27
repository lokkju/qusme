import { serve } from '@hono/node-server';
import { buildApp, configFromEnv, SWEEP_INTERVAL_MS } from './app.ts';

const config = configFromEnv(process.env);
const app = buildApp(config);
const port = Number(process.env.PORT ?? 8787);

// Delete expired service state, as the Workers cron trigger does (spec 8.5), and while the
// previous agent key secret is configured, re-encrypt agent keys under the current one.
setInterval(() => {
  app.sweep().catch((err: unknown) => console.error('sweep failed', err));
  if (config.agentKeys.rotating) {
    app
      .rotateAgentKeys()
      .then((r) => {
        if (r.reencrypted > 0 || r.failed.length > 0) {
          console.log('agent key rotation', { reencrypted: r.reencrypted, failed: r.failed });
        }
      })
      .catch((err: unknown) => console.error('agent key rotation failed', err));
  }
}, SWEEP_INTERVAL_MS).unref();

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`qus.me listening on http://localhost:${info.port}`);
});

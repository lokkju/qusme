import { serve } from '@hono/node-server';
import { buildApp, configFromEnv, SWEEP_INTERVAL_MS } from './app.ts';

const app = buildApp(configFromEnv(process.env));
const port = Number(process.env.PORT ?? 8787);

// Delete expired service state, as the Workers cron trigger does (spec 8.5).
setInterval(() => {
  app.sweep().catch((err: unknown) => console.error('sweep failed', err));
}, SWEEP_INTERVAL_MS).unref();

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`qus.me listening on http://localhost:${info.port}`);
});

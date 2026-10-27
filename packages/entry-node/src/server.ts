import { serve } from '@hono/node-server';
import { buildApp, configFromEnv } from './app.ts';

const app = buildApp(configFromEnv(process.env));
const port = Number(process.env.PORT ?? 8787);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`qus.me listening on http://localhost:${info.port}`);
});

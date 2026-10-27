import { expect, it } from 'vitest';
import worker, { type Env } from '../src/index.ts';

it('serves /healthz with the build-time version', async () => {
  // /healthz touches neither the database nor the secret.
  const env = { DB: {} as D1Database, QUSME_AGENT_KEY_SECRET: 'test-secret' } satisfies Env;
  const ctx = {} as ExecutionContext;
  const res = await worker.fetch(new Request('https://app.qus.me/healthz'), env, ctx);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, version: 'test-version' });
});

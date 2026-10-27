import { expect, it } from 'vitest';
import worker, { type Env } from '../src/index.ts';

// Neither test reaches the database: /healthz never does, and a missing header fails first.
const env = {
  DB: {} as D1Database,
  QUSME_AGENT_KEY_SECRET: 'test-secret',
  QUSME_PUBLIC_ORIGIN: 'https://app.qus.me',
} satisfies Env;
const ctx = {} as ExecutionContext;

it('serves /healthz with the build-time version', async () => {
  const res = await worker.fetch(new Request('https://app.qus.me/healthz'), env, ctx);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, version: 'test-version' });
});

it('requires NIP-98 on authenticated routes', async () => {
  const res = await worker.fetch(
    new Request('https://app.qus.me/pair', { method: 'POST' }),
    env,
    ctx
  );
  expect(res.status).toBe(401);
  expect(res.headers.get('WWW-Authenticate')).toBe('Nostr');
});

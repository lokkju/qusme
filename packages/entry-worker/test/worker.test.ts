import { RATE_CLASSES, type RateLimitBinding } from '@qusme/core';
import { expect, it, vi } from 'vitest';
import worker, { type Env } from '../src/index.ts';

/** A rate limiting binding that allows `allowed` calls, recording each key. */
function binding(allowed = Infinity) {
  const keys: string[] = [];
  const b: RateLimitBinding & { keys: string[] } = {
    keys,
    async limit({ key }) {
      keys.push(key);
      return { success: keys.length <= allowed };
    },
  };
  return b;
}

const bindings = () => ({
  RL_IP_AUTHORIZE: binding(),
  RL_IP_POLL: binding(),
  RL_IP_TOKEN: binding(),
  RL_IP_PAIR: binding(),
  RL_MCP_AGENT_FREE: binding(),
  RL_MCP_QUEUE_FREE: binding(),
  RL_DEVICE_QUEUE_FREE: binding(),
});

// No test reaches the database: /healthz never does, and the others fail before it.
const env = {
  DB: {} as D1Database,
  QUSME_AGENT_KEY_SECRET: btoa('w'.repeat(32)),
  QUSME_PUBLIC_ORIGIN: 'https://app.qus.me',
  ...bindings(),
} satisfies Env;
const ctx = {} as ExecutionContext;

it('refuses requests when the ceiling is malformed', () => {
  expect(() =>
    worker.fetch(
      new Request('https://app.qus.me/healthz'),
      { ...env, QUSME_DAILY_DRAFT_CEILING: 'lots' },
      ctx
    )
  ).toThrow('QUSME_DAILY_DRAFT_CEILING');
});

it('serves without any rate limiting binding, limiting in memory and warning once per binding', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  try {
    const bare = {
      DB: {} as D1Database,
      QUSME_AGENT_KEY_SECRET: btoa('w'.repeat(32)),
      QUSME_PUBLIC_ORIGIN: 'https://app.qus.me',
    } satisfies Env;
    const health = await worker.fetch(new Request('https://app.qus.me/healthz'), bare, ctx);
    expect(health.status).toBe(200);
    // /token checks its limit, then refuses a non-form body without touching the database.
    const token = () =>
      worker.fetch(
        new Request('https://app.qus.me/token', {
          method: 'POST',
          headers: { 'CF-Connecting-IP': '203.0.113.20', 'Content-Type': 'text/plain' },
          body: 'x',
        }),
        bare,
        ctx
      );
    for (let i = 0; i < RATE_CLASSES.ip_token.limit; i++) expect((await token()).status).toBe(400);
    const over = await token();
    expect(over.status).toBe(429);
    expect(Number(over.headers.get('Retry-After'))).toBeGreaterThan(0);
    const lines = warn.mock.calls.map((c) => String(c[0]));
    expect(
      lines.filter((l) => l === 'ratelimit_binding_unavailable name=RL_IP_TOKEN')
    ).toHaveLength(1);
    expect(lines.every((l) => /^ratelimit_binding_unavailable name=RL_[A-Z_]+$/.test(l))).toBe(
      true
    );
  } finally {
    warn.mockRestore();
  }
});

it('lets a request through when a binding call throws', async () => {
  const failing: RateLimitBinding = {
    async limit() {
      throw new Error('rate limiter down');
    },
  };
  const res = await worker.fetch(
    new Request('https://app.qus.me/token', {
      method: 'POST',
      headers: { 'CF-Connecting-IP': '203.0.113.21', 'Content-Type': 'text/plain' },
      body: 'x',
    }),
    { ...env, RL_IP_TOKEN: failing },
    ctx
  );
  // Past the limiter to the route's own refusal.
  expect(res.status).toBe(400);
});

it('rate-limits through the bindings, keyed by CF-Connecting-IP, with Retry-After', async () => {
  const limited = { ...env, ...bindings(), RL_IP_PAIR: binding(1) };
  const lookup = () =>
    worker.fetch(
      new Request('https://app.qus.me/pair/0000-0000', {
        headers: { 'CF-Connecting-IP': '203.0.113.5' },
      }),
      limited,
      ctx
    );
  // The first lookup passes the limit and reaches the database, which this test does not have.
  try {
    await lookup();
  } catch {
    // Expected: no database.
  }
  const res = await lookup();
  expect(res.status).toBe(429);
  expect(res.headers.get('Retry-After')).toBe(String(RATE_CLASSES.ip_pair.period));
  expect(limited.RL_IP_PAIR.keys).toEqual(['203.0.113.5', '203.0.113.5']);
});

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

import { describe, expect, it } from 'vitest';
import { buildApp, configFromEnv } from '../src/app.ts';

describe('the Node entrypoint', () => {
  it('serves /healthz over a fresh SQLite database', async () => {
    const app = buildApp({ dbPath: ':memory:', agentKeySecret: 'test-secret', version: 'v-test' });
    const res = await app.request('/healthz');
    expect(await res.json()).toEqual({ ok: true, version: 'v-test' });
  });

  it('refuses to start without the agent key secret', () => {
    expect(() => configFromEnv({})).toThrow(/QUSME_AGENT_KEY_SECRET/);
  });

  it('defaults the version to dev', () => {
    expect(configFromEnv({ QUSME_AGENT_KEY_SECRET: 'x' }).version).toBe('dev');
  });
});

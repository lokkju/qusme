import { buildHttpAuth, createLocalSigner, httpAuthHeader } from '@qusme/nostr';
import { describe, expect, it } from 'vitest';
import { buildApp, configFromEnv } from '../src/app.ts';

const config = {
  dbPath: ':memory:',
  agentKeySecret: 'test-secret',
  version: 'v-test',
  publicOrigin: 'https://app.qus.me',
};

describe('the Node entrypoint', () => {
  it('serves /healthz over a fresh SQLite database', async () => {
    const app = buildApp(config);
    const res = await app.request('/healthz');
    expect(await res.json()).toEqual({ ok: true, version: 'v-test' });
  });

  it('refuses to start without the agent key secret', () => {
    expect(() => configFromEnv({})).toThrow(/QUSME_AGENT_KEY_SECRET/);
  });

  it('defaults the version to dev', () => {
    expect(configFromEnv({ QUSME_AGENT_KEY_SECRET: 'x' }).version).toBe('dev');
  });

  it('defaults the public origin to app.qus.me and takes QUSME_PUBLIC_ORIGIN', () => {
    expect(configFromEnv({ QUSME_AGENT_KEY_SECRET: 'x' }).publicOrigin).toBe('https://app.qus.me');
    const env = { QUSME_AGENT_KEY_SECRET: 'x', QUSME_PUBLIC_ORIGIN: 'http://localhost:8787' };
    expect(configFromEnv(env).publicOrigin).toBe('http://localhost:8787');
  });

  it('verifies NIP-98 against the public origin behind the proxy, once per event', async () => {
    const app = buildApp(config);
    const signer = createLocalSigner(new Uint8Array(32).fill(7));
    const body = '{}';
    const event = await buildHttpAuth(signer, {
      url: 'https://app.qus.me/rotate',
      method: 'POST',
      body,
    });
    // The request as the Node server sees it behind Traefik: its own host and plain http.
    const send = () =>
      app.request('http://qusme.qusme.svc:8787/rotate', {
        method: 'POST',
        headers: { Authorization: httpAuthHeader(event), 'X-Forwarded-Host': 'elsewhere' },
        body,
      });
    expect((await send()).status).toBe(501);
    const replay = await send();
    expect(replay.status).toBe(401);
    expect(await replay.json()).toEqual({ error: 'unauthorized', reason: 'event already used' });
  });
});

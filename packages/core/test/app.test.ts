import { buildHttpAuth, createLocalSigner, httpAuthHeader, PairingSource } from '@qusme/nostr';
import type { QusmeDb } from '@qusme/store-sql';
import { openSqlite } from '@qusme/store-sql/sqlite';
import { describe, expect, it } from 'vitest';
import { createAgentKeyRing, createApp } from '../src/index.ts';

const app = createApp({
  version: 'test-version',
  // These tests reach no route that touches the database.
  db: {} as QusmeDb,
  agentKeys: createAgentKeyRing({ secret: btoa('k'.repeat(32)) }),
  publicOrigin: 'https://app.qus.me',
});

describe('createApp', () => {
  it('reports health and the build version', async () => {
    const res = await app.request('/healthz');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, version: 'test-version' });
  });

  it('requires a bearer token on /mcp', async () => {
    const res = await app.request('/mcp', { method: 'POST' });
    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toMatch(/^Bearer resource_metadata=/);
  });

  it('requires NIP-98 on /pair and /rotate', async () => {
    for (const path of ['/pair', '/rotate']) {
      const res = await app.request(path, { method: 'POST' });
      expect(res.status).toBe(401);
      expect(res.headers.get('WWW-Authenticate')).toBe('Nostr');
    }
  });

  it('mounts the typed-code rendezvous at /pair', async () => {
    const live = createApp({
      version: 'v',
      db: openSqlite(':memory:'),
      agentKeys: createAgentKeyRing({ secret: btoa('k'.repeat(32)) }),
      publicOrigin: 'https://app.qus.me',
    });
    const uri = new PairingSource(['wss://nos.lol']).uri;
    const body = JSON.stringify({ uri });
    const signer = createLocalSigner(new Uint8Array(32).fill(5));
    const auth = httpAuthHeader(
      await buildHttpAuth(signer, { url: 'https://app.qus.me/pair', method: 'POST', body })
    );
    const created = await live.request('/pair', {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body,
    });
    expect(created.status).toBe(201);
    const { code } = (await created.json()) as { code: string };
    const fetched = await live.request(`/pair/${code}`);
    expect(((await fetched.json()) as { uri: string }).uri).toBe(uri);
  });

  it('refuses a public origin with a path', () => {
    expect(() =>
      createApp({
        version: 'v',
        db: {} as QusmeDb,
        agentKeys: createAgentKeyRing({ secret: btoa('k'.repeat(32)) }),
        publicOrigin: 'https://app.qus.me/api',
      })
    ).toThrow(/scheme and host only/);
  });

  it('answers 404 elsewhere', async () => {
    const res = await app.request('/nope');
    expect(res.status).toBe(404);
  });
});

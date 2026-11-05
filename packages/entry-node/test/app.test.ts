import { createAgentKeyRing } from '@qusme/core';
import {
  buildHttpAuth,
  createLocalSigner,
  httpAuthHeader,
  KIND_SITE_DEF,
  REGISTRY_SNAPSHOT_FORMAT,
} from '@qusme/nostr';
import { describe, expect, it } from 'vitest';
import { buildApp, configFromEnv } from '../src/app.ts';

const SECRET = btoa('n'.repeat(32));

const config = {
  dbPath: ':memory:',
  agentKeys: createAgentKeyRing({ secret: SECRET }),
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

  it('refuses to start with a secret that is not base64 of 32 bytes', () => {
    expect(() => configFromEnv({ QUSME_AGENT_KEY_SECRET: 'test-secret' })).toThrow(
      /QUSME_AGENT_KEY_SECRET must be standard base64 of 32 bytes/
    );
    expect(() => configFromEnv({ QUSME_AGENT_KEY_SECRET: btoa('n'.repeat(31)) })).toThrow(
      /32 bytes/
    );
  });

  it('reads the key version and the previous secret for a rotation', () => {
    const ring = configFromEnv({
      QUSME_AGENT_KEY_SECRET: SECRET,
      QUSME_AGENT_KEY_VERSION: '2',
      QUSME_AGENT_KEY_SECRET_PREVIOUS: btoa('o'.repeat(32)),
    }).agentKeys;
    expect(ring.currentVersion).toBe(2);
    expect(ring.rotating).toBe(true);
    expect(ring.has(1)).toBe(true);
    expect(() =>
      configFromEnv({ QUSME_AGENT_KEY_SECRET: SECRET, QUSME_AGENT_KEY_SECRET_PREVIOUS: SECRET })
    ).toThrow(/QUSME_AGENT_KEY_VERSION of 2 or more/);
  });

  it('defaults the version to dev', () => {
    expect(configFromEnv({ QUSME_AGENT_KEY_SECRET: SECRET }).version).toBe('dev');
  });

  it('defaults the public origin to app.qus.me and takes QUSME_PUBLIC_ORIGIN', () => {
    expect(configFromEnv({ QUSME_AGENT_KEY_SECRET: SECRET }).publicOrigin).toBe(
      'https://app.qus.me'
    );
    const env = { QUSME_AGENT_KEY_SECRET: SECRET, QUSME_PUBLIC_ORIGIN: 'http://localhost:8787' };
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

  it('loads the bundled registry snapshot, which verifies against the pinned key', () => {
    const logs: string[] = [];
    const app = buildApp(config, (line) => logs.push(line));
    expect(logs).toEqual([]);
    expect(Array.isArray(app.registry)).toBe(true);
  });

  it('loads verified definitions from a snapshot and drops the rest with a log line', async () => {
    // A throwaway publisher, pinned for this test only, and a key that isn't it.
    const publisher = createLocalSigner(crypto.getRandomValues(new Uint8Array(32)));
    const stranger = createLocalSigner(crypto.getRandomValues(new Uint8Array(32)));
    const pubkey = await publisher.getPublicKey();
    const definition = {
      id: 'example',
      version: '2026.11.1',
      name: 'Example',
      match: ['https://example.com/*'],
      fields: [
        {
          name: 'text',
          label: 'Post text',
          locators: [{ role: 'textbox', name: { en: ['Post text'] } }],
          inject: ['paste', 'clipboard'],
          constraints: { maxLength: 280 },
        },
      ],
    };
    const sign = (def: typeof definition, signer = publisher) =>
      signer.signEvent({
        kind: KIND_SITE_DEF,
        created_at: 1_793_836_800,
        tags: [['d', def.id]],
        content: JSON.stringify(def),
      });
    const tampered = { ...(await sign({ ...definition, id: 'tampered' })), content: '{}' };
    const foreign = await sign({ ...definition, id: 'foreign' }, stranger);
    const snapshot = {
      format: REGISTRY_SNAPSHOT_FORMAT,
      publisher: pubkey,
      siteDefinitions: [await sign(definition), tampered, foreign],
    };
    const logs: string[] = [];
    const app = buildApp({ ...config, registry: { snapshot, publisher: pubkey } }, (line) =>
      logs.push(line)
    );
    expect(app.registry).toEqual([definition]);
    expect(logs).toEqual([
      'registry snapshot: dropped siteDefinitions[1]: id or signature does not verify',
      'registry snapshot: dropped siteDefinitions[2]: pubkey: not signed by the registry publisher key',
    ]);

    // Without the test pin, the production key refuses the whole snapshot.
    const unpinned: string[] = [];
    const refused = buildApp(
      { ...config, registry: { snapshot, publisher: 'f'.repeat(64) } },
      (l) => unpinned.push(l)
    );
    expect(refused.registry).toEqual([]);
    expect(unpinned).toEqual(['registry snapshot: dropped publisher: not the pinned key']);
  });
});

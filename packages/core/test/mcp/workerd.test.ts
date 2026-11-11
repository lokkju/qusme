import { fileURLToPath } from 'node:url';
import { compareSiteVersions } from '@qusme/nostr';
import { createStore, hashSecret } from '@qusme/store-sql';
import { openD1 } from '@qusme/store-sql/d1';
import { build } from 'esbuild';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { expect, it } from 'vitest';
import { migrationStatements } from '../../../store-sql/test/harness.ts';
import {
  createAgentKeyCustody,
  createAgentKeyRing,
  DEFAULT_MAX_POW,
  RATE_CLASSES,
} from '../../src/index.ts';

const SECRET = btoa('w'.repeat(32));
const CLIENT_ID = 'https://client.example/oauth/client-metadata.json';

/** The Workers entrypoint, bundled for workerd as wrangler bundles it. */
async function bundleWorker(): Promise<string> {
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL('../../../entry-worker/src/index.ts', import.meta.url))],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    mainFields: ['module', 'main'],
    conditions: ['workerd', 'worker', 'browser'],
    define: { __QUSME_VERSION__: '"workerd-test"' },
    write: false,
  });
  const script = bundle.outputFiles[0]?.text;
  if (script === undefined) throw new Error('esbuild produced no output');
  return script;
}

// The Workers entrypoint serving /mcp through the MCP SDK in the Workers runtime itself, with
// wrangler.jsonc's proof of work cap.
for (const withBindings of [true, false]) {
  const how = withBindings ? 'with' : 'without';
  it(`serves MCP tools under the Workers runtime ${how} Rate Limiting bindings`, {
    timeout: 60_000,
  }, async () => {
    const script = await bundleWorker();

    const mf = new Miniflare(
      convertV4MiniflareOptions({
        workers: [
          {
            name: 'qusme',
            compatibilityDate: '2026-10-20',
            modules: [{ type: 'ESModule', path: 'index.mjs', contents: script }],
            d1Databases: { DB: `workerd-mcp-${how}` },
            bindings: {
              QUSME_AGENT_KEY_SECRET: SECRET,
              QUSME_PUBLIC_ORIGIN: 'https://app.qus.me',
              QUSME_MAX_POW: String(DEFAULT_MAX_POW),
            },
            // workerd's own Rate Limiting bindings, as wrangler.jsonc declares them.
            ...(withBindings && {
              ratelimits: Object.fromEntries(
                Object.values(RATE_CLASSES).map((c, i) => [
                  c.binding,
                  { namespace_id: String(7701 + i), simple: { limit: c.limit, period: c.period } },
                ])
              ),
            }),
          },
        ],
      })
    );
    try {
      const d1 = await mf.getD1Database('DB');
      for (const statements of migrationStatements()) {
        await d1.batch(statements.map((s) => d1.prepare(s)));
      }
      const store = createStore(openD1(d1 as unknown as Parameters<typeof openD1>[0]));
      const now = Math.floor(Date.now() / 1000);
      await store.oauthClients.upsert({
        clientId: CLIENT_ID,
        metadata: {},
        clientName: 'Example Agent',
        redirectUris: [],
        registrationSource: 'metadata_document',
        fetchedAt: now,
        createdAt: now,
      });
      const ring = createAgentKeyRing({ secret: SECRET });
      const key = await createAgentKeyCustody(store, ring).mint({ clientId: CLIENT_ID, now });
      await store.bindings.create({
        agentKeyId: key.id,
        queuePubkey: 'a'.repeat(64),
        clientLabel: 'Example Agent',
        storageRelays: ['wss://storage.example/'],
        createdAt: now,
        updatedAt: now,
      });
      // A grant's storage relays move the binding on workerd's D1 (spec 8.4), and only a newer
      // grant moves it again, in one guarded statement; the binding is put back for the tools.
      const queue = 'a'.repeat(64);
      const moved = ['wss://storage.example/', 'wss://storage2.example/'];
      expect(await store.bindings.moveStorage(key.id, queue, moved, now - 10, now)).toMatchObject({
        storageRelays: moved,
        storageGrantAt: now - 10,
      });
      expect(
        await store.bindings.moveStorage(key.id, queue, ['wss://old.example/'], now - 20, now)
      ).toBeUndefined();
      expect(
        await store.bindings.moveStorage(key.id, 'b'.repeat(64), ['wss://x.example/'], now, now)
      ).toBeUndefined();
      expect((await store.bindings.get(key.id))?.storageRelays).toEqual(moved);
      await store.bindings.update(key.id, {
        storageRelays: ['wss://storage.example/'],
        storageGrantAt: null,
      });
      const token = `qat_${crypto.randomUUID()}`;
      await store.oauthTokens.create({
        tokenHash: await hashSecret(token),
        kind: 'access',
        clientId: CLIENT_ID,
        agentKeyId: key.id,
        scopes: 'drafts:submit',
        createdAt: now,
        expiresAt: now + 3600,
      });

      const rpc = async (method: string, params: unknown) => {
        const res = await mf.dispatchFetch('https://app.qus.me/mcp', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            'MCP-Protocol-Version': '2025-11-25',
          },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        });
        expect(res.status).toBe(200);
        const text = await res.text();
        // A JSON body, or one SSE event carrying it.
        const json = text.startsWith('{') ? text : (/^data: (.*)$/m.exec(text)?.[1] ?? '');
        return JSON.parse(json) as { result: Record<string, unknown> };
      };

      const tools = await rpc('tools/list', {});
      expect((tools.result.tools as { name: string }[]).map((t) => t.name).sort()).toEqual([
        'create_draft',
        'get_definition',
        'list_destinations',
        'list_registry',
        'list_submissions',
      ]);
      const registry = await rpc('tools/call', { name: 'list_registry', arguments: {} });
      // The bundled snapshot moves with every registry bump, so the version is only a floor.
      const listed = registry.result.structuredContent as {
        sites: { id: string; version: string }[];
      };
      expect(listed.sites.map((s) => s.id)).toEqual(['bsky', 'linkedin', 'mastodon', 'x']);
      const x = listed.sites.find((s) => s.id === 'x');
      expect(compareSiteVersions(x?.version ?? '', '2026.11.2')).toBeGreaterThanOrEqual(0);
      expect(x).toEqual({
        id: 'x',
        name: 'X',
        version: expect.any(String),
        match: ['https://x.com/*', 'https://twitter.com/*'],
        fields: [
          {
            name: 'text',
            label: 'Post text',
            constraints: { maxLength: 280, counter: 'twitter-text' },
          },
        ],
      });
    } finally {
      await mf.dispose();
    }
  });
}

it('refuses requests under the Workers runtime when QUSME_MAX_POW is above 256', {
  timeout: 60_000,
}, async () => {
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      workers: [
        {
          name: 'qusme',
          compatibilityDate: '2026-10-20',
          modules: [{ type: 'ESModule', path: 'index.mjs', contents: await bundleWorker() }],
          d1Databases: { DB: 'workerd-mcp-max-pow' },
          bindings: {
            QUSME_AGENT_KEY_SECRET: SECRET,
            QUSME_PUBLIC_ORIGIN: 'https://app.qus.me',
            QUSME_MAX_POW: '300',
          },
        },
      ],
    })
  );
  try {
    const res = await mf.dispatchFetch('https://app.qus.me/healthz');
    expect(res.status).toBe(500);
    await res.text();
  } finally {
    await mf.dispose();
  }
});

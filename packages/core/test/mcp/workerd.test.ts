import { fileURLToPath } from 'node:url';
import { createStore, hashSecret } from '@qusme/store-sql';
import { openD1 } from '@qusme/store-sql/d1';
import { build } from 'esbuild';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { expect, it } from 'vitest';
import { migrationStatements } from '../../../store-sql/test/harness.ts';
import { createAgentKeyCustody, createAgentKeyRing } from '../../src/index.ts';

const SECRET = btoa('w'.repeat(32));
const CLIENT_ID = 'https://client.example/oauth/client-metadata.json';

// The Workers entrypoint, bundled for workerd as wrangler bundles it, serving /mcp through the
// MCP SDK in the Workers runtime itself.
it('serves MCP tools under the Workers runtime', { timeout: 60_000 }, async () => {
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

  const mf = new Miniflare(
    convertV4MiniflareOptions({
      workers: [
        {
          name: 'qusme',
          compatibilityDate: '2026-10-20',
          modules: [{ type: 'ESModule', path: 'index.mjs', contents: script }],
          d1Databases: { DB: 'workerd-mcp' },
          bindings: { QUSME_AGENT_KEY_SECRET: SECRET, QUSME_PUBLIC_ORIGIN: 'https://app.qus.me' },
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
    expect(registry.result.structuredContent).toEqual({ sites: [] });
  } finally {
    await mf.dispose();
  }
});

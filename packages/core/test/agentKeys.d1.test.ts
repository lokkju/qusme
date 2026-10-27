import { createStore } from '@qusme/store-sql';
import { openD1 } from '@qusme/store-sql/d1';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { afterAll, beforeAll } from 'vitest';
import { migrationStatements } from '../../store-sql/test/harness.ts';
import { custodySuite } from './agentKeys.suite.ts';

// D1 as workerd runs it, through Miniflare, as store-sql's own D1 tests do.
let mf: Miniflare;
let d1: Awaited<ReturnType<Miniflare['getD1Database']>>;

beforeAll(async () => {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      workers: [
        {
          name: 'custody',
          compatibilityDate: '2026-10-20',
          modules: [
            {
              type: 'ESModule',
              path: 'custody.mjs',
              contents:
                'export default { fetch() { return new Response(null, { status: 204 }); } };',
            },
          ],
          d1Databases: { DB: 'custody-test' },
        },
      ],
    })
  );
  d1 = await mf.getD1Database('DB');
  for (const statements of migrationStatements()) {
    await d1.batch(statements.map((s) => d1.prepare(s)));
  }
}, 60_000);

afterAll(async () => {
  await mf?.dispose();
});

custodySuite('D1 (Miniflare)', () => ({
  async fresh() {
    // agent_keys cascades to everything that refers to it.
    await d1.batch(['agent_keys', 'oauth_clients'].map((t) => d1.prepare(`DELETE FROM ${t}`)));
    const db = openD1(d1 as unknown as Parameters<typeof openD1>[0]);
    return { db, store: createStore(db) };
  },
}));

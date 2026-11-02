import { openD1 } from '@qusme/store-sql/d1';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { afterAll, beforeAll } from 'vitest';
import { migrationStatements } from '../../store-sql/test/harness.ts';
import { pairingSuite } from './pairing.suite.ts';

// D1 as workerd runs it, through Miniflare, as store-sql's own D1 tests do.
let mf: Miniflare;
let d1: Awaited<ReturnType<Miniflare['getD1Database']>>;

beforeAll(async () => {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      workers: [
        {
          name: 'pairing',
          compatibilityDate: '2026-10-20',
          modules: [
            {
              type: 'ESModule',
              path: 'pairing.mjs',
              contents:
                'export default { fetch() { return new Response(null, { status: 204 }); } };',
            },
          ],
          d1Databases: { DB: 'pairing-test' },
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

pairingSuite('D1 (Miniflare)', () => ({
  async fresh() {
    await d1.batch(
      ['pairing_sessions', 'nip98_replays'].map((t) => d1.prepare(`DELETE FROM ${t}`))
    );
    return openD1(d1 as unknown as Parameters<typeof openD1>[0]);
  },
}));

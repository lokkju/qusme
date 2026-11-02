import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { expect, it } from 'vitest';

it('runs under the Workers runtime', { timeout: 60_000 }, async () => {
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL('./fixtures/smoke-worker.ts', import.meta.url))],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    conditions: ['workerd', 'worker', 'browser'],
    write: false,
  });
  const script = bundle.outputFiles[0]?.text;
  if (script === undefined) throw new Error('esbuild produced no output');

  const mf = new Miniflare(
    convertV4MiniflareOptions({
      workers: [
        {
          name: 'smoke',
          compatibilityDate: '2026-10-20',
          modules: [{ type: 'ESModule', path: 'smoke-worker.mjs', contents: script }],
        },
      ],
    })
  );
  try {
    const res = await mf.dispatchFetch('http://localhost/');
    expect(await res.json()).toEqual({
      draft: 'field_value',
      self: 'to self',
      rumor: 'wrapped',
      sealedByAgent: true,
      pairing: true,
      ncryptsec: true,
      counts: [5, 1, 26, false],
    });
  } finally {
    await mf.dispose();
  }
});

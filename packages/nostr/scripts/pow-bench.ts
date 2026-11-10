/**
 * Measures NIP-13 mining speed under workerd (spec 7.4): how many gift wrap id hashes one Worker
 * request computes per millisecond, for wraps of a few sizes, and so how many bits fit in a CPU
 * budget. `js` is minePow's loop (nostr-tools' getEventHash, pure-JS SHA-256); `subtle` hashes
 * the same bytes with WebCrypto's native SHA-256, for comparison. workerd freezes its clocks
 * while a request computes, so the time is measured from Node around each request, less the
 * median of empty requests. Wall time stands in for CPU time: the requests do no I/O.
 *   pnpm -C packages/nostr pow-bench [hashes per request, default 2000] [rounds, default 5]
 */
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';

const HASHES = Number(process.argv[2] ?? 2_000);
const ROUNDS = Number(process.argv[3] ?? 5);
// Gift wrap content lengths: a short value (about 100 bytes), a few KiB, and the largest value
// create_draft takes (32 KiB, base64 inside base64 by NIP-44 twice).
const SIZES = [1_500, 8_000, 60_000];

const worker = `
import { getEventHash } from 'nostr-tools/pure';
import { powOf } from './src/nip13.ts';
export default {
  async fetch(request) {
    const url = new URL(request.url);
    const n = Number(url.searchParams.get('n'));
    const size = Number(url.searchParams.get('size'));
    const tag = ['nonce', '0', '20'];
    const event = {
      kind: 1059,
      pubkey: 'f'.repeat(64),
      created_at: 1793836800,
      tags: [['p', 'e'.repeat(64)], ['expiration', '1796428800'], tag],
      content: 'A'.repeat(size),
    };
    let best = 0;
    if (url.searchParams.get('mode') === 'subtle') {
      // WebCrypto's native SHA-256 over the serialized event, split around the nonce once.
      const marker = '"nonce","\u0000"';
      const text = JSON.stringify([0, event.pubkey, event.created_at, event.kind,
        event.tags.map((t) => (t === tag ? ['nonce', '\u0000', t[2]] : t)), event.content]);
      const [head, tail] = text.split(marker);
      const enc = new TextEncoder();
      const pre = enc.encode(head + '"nonce","'), post = enc.encode('"' + tail);
      const buf = new Uint8Array(pre.length + 16 + post.length);
      buf.set(pre);
      for (let nonce = 0; nonce < n; nonce++) {
        const digits = enc.encode(String(nonce));
        buf.set(digits, pre.length);
        buf.set(post, pre.length + digits.length);
        const len = pre.length + digits.length + post.length;
        const id = new Uint8Array(await crypto.subtle.digest('SHA-256', buf.subarray(0, len)));
        let bits = 0;
        for (const b of id) { if (b === 0) { bits += 8; continue; } bits += Math.clz32(b) - 24; break; }
        best = Math.max(best, bits);
      }
    } else {
      for (let nonce = 0; nonce < n; nonce++) {
        tag[1] = String(nonce);
        best = Math.max(best, powOf(getEventHash(event)));
      }
    }
    return new Response(String(best));
  },
};`;

const bundle = await build({
  stdin: {
    contents: worker,
    resolveDir: fileURLToPath(new URL('..', import.meta.url)),
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  mainFields: ['module', 'main'],
  conditions: ['workerd', 'worker', 'browser'],
  write: false,
});
const script = bundle.outputFiles[0]?.text;
if (script === undefined) throw new Error('esbuild produced no output');

const mf = new Miniflare(
  convertV4MiniflareOptions({
    workers: [
      {
        name: 'bench',
        compatibilityDate: '2026-10-20',
        modules: [{ type: 'ESModule', path: 'index.mjs', contents: script }],
      },
    ],
  })
);
const median = (xs: number[]) => xs.toSorted((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
async function time(n: number, size: number, mode = 'js'): Promise<number> {
  const start = performance.now();
  const response = await mf.dispatchFetch(`http://bench/?n=${n}&size=${size}&mode=${mode}`);
  await response.text();
  return performance.now() - start;
}

try {
  for (let i = 0; i < 3; i++) await time(HASHES, SIZES[0] ?? 0); // warm up the JIT
  const baseline = [];
  for (let i = 0; i < ROUNDS; i++) baseline.push(await time(0, 0));
  const overhead = median(baseline);
  console.log(`request overhead ${overhead.toFixed(2)} ms; ${HASHES} hashes per request`);
  for (const [mode, size] of ['js', 'subtle'].flatMap((m) => SIZES.map((s) => [m, s] as const))) {
    const runs = [];
    for (let i = 0; i < ROUNDS; i++) runs.push((await time(HASHES, size, mode)) - overhead);
    const perMs = HASHES / median(runs);
    // 2^bits hashes on average; bits that fit in 1, 5 and 10 ms of CPU on average.
    const fit = (ms: number) => Math.log2(perMs * ms).toFixed(1);
    console.log(
      `${mode} content ${size} B: ${perMs.toFixed(0)} hashes/ms ` +
        `(${(1000 / perMs).toFixed(2)} µs each); bits on average in 1 ms ${fit(1)}, ` +
        `5 ms ${fit(5)}, 10 ms ${fit(10)}`
    );
  }
} finally {
  await mf.dispose();
}

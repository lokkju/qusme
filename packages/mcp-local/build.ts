/**
 * Bundles the CLI into one file, `dist/cli.js`, with every dependency inside it: the workspace
 * packages it reuses (`@qusme/core/mcp`, `@qusme/nostr`) export TypeScript source and are never
 * published, so the npm package has no runtime dependencies at all. The repository's licence goes
 * into `dist/` beside it.
 */
import { copyFileSync, mkdirSync } from 'node:fs';
import { build } from 'esbuild';

const root = new URL('.', import.meta.url);
mkdirSync(new URL('dist/', root), { recursive: true });
await build({
  entryPoints: [new URL('src/cli.ts', root).pathname],
  outfile: new URL('dist/cli.js', root).pathname,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  minify: false,
  legalComments: 'linked',
  // Some bundled CommonJS calls require(); give the ESM bundle one.
  banner: {
    js: "import { createRequire as __qusmeRequire } from 'node:module'; const require = __qusmeRequire(import.meta.url);",
  },
  logLevel: 'warning',
});
copyFileSync(new URL('../../LICENSE', root), new URL('dist/LICENSE', root));

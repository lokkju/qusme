/**
 * Starts the harness (`server.ts`) in its own Node process, so the workspace packages run under
 * Node's own TypeScript support as they do everywhere else, and prepares the extension the tests
 * load. The ports reach the test workers through {@link HARNESS_ENV}.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { HARNESS_ENV } from './constants.ts';
import { EXTENSION_BUILD, prepareExtension } from './extension.ts';

export default async function globalSetup(): Promise<() => Promise<void>> {
  if (!existsSync(`${EXTENSION_BUILD}/manifest.json`)) {
    throw new Error(
      `${EXTENSION_BUILD} is missing: run \`pnpm -C packages/extension exec wxt build\` first`
    );
  }
  prepareExtension();

  const child: ChildProcess = spawn(
    process.execPath,
    [fileURLToPath(new URL('./server.ts', import.meta.url))],
    { stdio: ['ignore', 'pipe', 'inherit'] }
  );
  const ports = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the harness did not start in 30 s')), 30_000);
    child.once('exit', (code) => reject(new Error(`the harness exited with ${code}`)));
    // biome-ignore lint/style/noNonNullAssertion: stdout is piped above.
    createInterface({ input: child.stdout! }).once('line', (line) => {
      clearTimeout(timer);
      resolve(line);
    });
  });
  process.env[HARNESS_ENV] = ports;

  return async () => {
    child.kill('SIGTERM');
  };
}

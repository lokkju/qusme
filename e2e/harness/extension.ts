/**
 * The extension under test: the production Chrome build, copied, with host permissions added to
 * the copy's manifest. Nothing in the extension's source or its build changes for the tests.
 *
 * The two host permissions stand in for user gestures automation can't make. `https://app.qus.me/*`
 * is the extension's optional permission, which Chrome would grant through a prompt when the user
 * approves an agent; granted at install, `permissions.request` resolves without one.
 * `http://127.0.0.1/*` stands in for activeTab, which Chrome grants when the user clicks the
 * toolbar button or presses Alt+Q, so the popup can run the insertion script in the compose page.
 */
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const EXTENSION_BUILD = fileURLToPath(
  new URL('../../packages/extension/.output/chrome-mv3', import.meta.url)
);

/** Where the prepared copy is, for the test workers. */
export const EXTENSION_ENV = 'QUSME_E2E_EXTENSION';

export const TEST_HOST_PERMISSIONS = ['https://app.qus.me/*', 'http://127.0.0.1/*'];

export function prepareExtension(): string {
  const dir = join(mkdtempSync(join(tmpdir(), 'qusme-e2e-ext-')), 'chrome-mv3');
  cpSync(EXTENSION_BUILD, dir, { recursive: true });
  const manifestPath = join(dir, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  manifest.host_permissions = TEST_HOST_PERMISSIONS;
  writeFileSync(manifestPath, JSON.stringify(manifest));
  process.env[EXTENSION_ENV] = dir;
  return dir;
}

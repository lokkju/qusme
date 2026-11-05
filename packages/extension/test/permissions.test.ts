import { expect, it } from 'vitest';
import { OPTIONAL_HOST_PERMISSIONS, PERMISSIONS, SERVICE_ORIGIN } from '../src/permissions.ts';
import config from '../wxt.config.ts';

it('asks for exactly the permissions in spec 11.2', () => {
  expect([...PERMISSIONS].sort()).toEqual(['activeTab', 'contextMenus', 'scripting', 'storage']);
});

it('makes the service origin the only optional host permission', () => {
  expect(SERVICE_ORIGIN).toBe('https://app.qus.me');
  expect([...OPTIONAL_HOST_PERMISSIONS]).toEqual(['https://app.qus.me/*']);
});

it.each(['chrome', 'firefox'])('builds a %s manifest with no host permissions', (browser) => {
  const manifest = config.manifest as (env: { browser: string }) => Record<string, unknown>;
  const built = manifest({ browser });
  expect(built.permissions).toEqual([...PERMISSIONS]);
  expect(built.optional_host_permissions).toEqual([...OPTIONAL_HOST_PERMISSIONS]);
  expect(built.host_permissions).toBeUndefined();
  expect(built.optional_permissions).toBeUndefined();
});

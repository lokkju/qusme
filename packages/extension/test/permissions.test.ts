import { expect, it } from 'vitest';
import { PICKER_COMMAND } from '../src/commands.ts';
import { OPTIONAL_HOST_PERMISSIONS, PERMISSIONS, SERVICE_ORIGIN } from '../src/permissions.ts';
import config from '../wxt.config.ts';

it('asks for exactly the permissions in spec 11.2', () => {
  expect([...PERMISSIONS].sort()).toEqual([
    'activeTab',
    'alarms',
    'contextMenus',
    'scripting',
    'storage',
  ]);
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
  // Page access only through activeTab: nothing runs in or is reachable from pages on its own.
  expect(built.content_scripts).toBeUndefined();
  expect(built.web_accessible_resources).toBeUndefined();
  expect(built.externally_connectable).toBeUndefined();
});

it.each(['chrome', 'firefox'])('suggests Alt+Q for the %s picker command', (browser) => {
  const manifest = config.manifest as (env: { browser: string }) => Record<string, unknown>;
  const commands = manifest({ browser }).commands as Record<string, unknown>;
  expect(Object.keys(commands)).toEqual([PICKER_COMMAND]);
  expect(commands[PICKER_COMMAND]).toMatchObject({ suggested_key: { default: 'Alt+Q' } });
});

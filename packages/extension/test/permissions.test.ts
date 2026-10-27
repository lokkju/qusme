import { expect, it } from 'vitest';
import { PERMISSIONS } from '../src/permissions.ts';

it('asks for exactly the permissions in spec 11.2', () => {
  expect([...PERMISSIONS].sort()).toEqual(['activeTab', 'contextMenus', 'scripting', 'storage']);
});

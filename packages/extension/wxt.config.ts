import preact from '@preact/preset-vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'wxt';
import { COMMANDS } from './src/commands.ts';
import { OPTIONAL_HOST_PERMISSIONS, PERMISSIONS } from './src/permissions.ts';

export default defineConfig({
  manifestVersion: 3,
  vite: () => ({ plugins: [preact(), tailwindcss()] }),
  zip: {
    name: 'qusme',
    // AMO reviewers rebuild from the sources zip, and the build needs the
    // workspace packages (@qusme/nostr), the lockfile and the root config, so
    // the zip is taken from the repository root rather than this package.
    sourcesRoot: '../..',
    excludeSources: ['**/node_modules/**', '**/.output/**', '**/.wxt/**', '**/dist/**', '**/*.db'],
  },
  manifest: ({ browser }) => ({
    name: 'qus.me',
    description:
      'Drafts from you and from Claude, in a queue only you can read. Press Alt+Q in a post box, pick one and click Post yourself.',
    permissions: [...PERMISSIONS],
    // Requested only when a typed pairing code is used (spec 11.2, 8.3).
    optional_host_permissions: [...OPTIONAL_HOST_PERMISSIONS],
    // The picker shortcut (spec 11.5); running a command grants activeTab, nothing more.
    commands: COMMANDS,
    ...(browser === 'firefox' && {
      browser_specific_settings: {
        gecko: {
          id: 'extension@qus.me',
          // Nothing leaves the device except to the user's own relay and the qus.me service.
          data_collection_permissions: { required: ['none'] },
        },
      },
    }),
  }),
});

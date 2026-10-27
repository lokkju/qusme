import { defineConfig } from 'wxt';
import { PERMISSIONS } from './src/permissions.ts';

export default defineConfig({
  manifestVersion: 3,
  manifest: ({ browser }) => ({
    name: 'qus.me',
    description: 'Insert queued drafts into fields on the page you are on.',
    permissions: [...PERMISSIONS],
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

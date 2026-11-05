import preact from '@preact/preset-vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'wxt';
import { OPTIONAL_HOST_PERMISSIONS, PERMISSIONS } from './src/permissions.ts';

export default defineConfig({
  manifestVersion: 3,
  vite: () => ({ plugins: [preact(), tailwindcss()] }),
  manifest: ({ browser }) => ({
    name: 'qus.me',
    description: 'Insert queued drafts into fields on the page you are on.',
    permissions: [...PERMISSIONS],
    // Requested only when a typed pairing code is used (spec 11.2, 8.3).
    optional_host_permissions: [...OPTIONAL_HOST_PERMISSIONS],
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

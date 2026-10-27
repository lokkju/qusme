import { defineProject } from 'vitest/config';

export default defineProject({
  define: {
    __QUSME_VERSION__: JSON.stringify('test-version'),
  },
});

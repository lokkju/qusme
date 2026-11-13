import { defineConfig } from '@playwright/test';

/**
 * Browser end-to-end tests: the built Chrome extension in headless Chromium against the harness
 * (`harness/server.ts`). One worker, since the flows share the harness's relays and service.
 */
export default defineConfig({
  testDir: './tests',
  globalSetup: './harness/global-setup.ts',
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: process.env.CI ? [['github'], ['list'], ['html', { open: 'never' }]] : 'list',
  use: { trace: 'retain-on-failure' },
});

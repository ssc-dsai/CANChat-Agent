import { defineConfig } from '@playwright/test';

// E2E harness for the MV3 extension. One persistent browser context loads the
// unpacked build from `dist/`, so suites run serially with a single worker.
// The `test:e2e` npm script builds `dist/` first; CI does the same.
const isCI = !!process.env.CI;

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: false,
  workers: 1,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  outputDir: 'test-results',
  reporter: isCI ? [['html', { open: 'never' }], ['list']] : [['list']],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [{ name: 'chromium' }],
});

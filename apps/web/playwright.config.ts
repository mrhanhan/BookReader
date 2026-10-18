import { defineConfig, devices } from '@playwright/test';

/**
 * Acceptance tests run against an already-deployed stack (Docker Compose).
 * The public entry point is Caddy on 8180; override it with E2E_BASE_URL.
 */
const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:8180';

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  // Every test shares one real library, so runs must not interleave.
  workers: 1,
  fullyParallel: false,
  timeout: 120_000,
  expect: { timeout: 10_000 },
  // One retry absorbs transient tile re-renders; a failed first attempt still
  // leaves its trace next to the report.
  retries: 1,
  reporter: 'list',
  use: {
    baseURL,
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});

import { defineConfig, devices } from '@playwright/test';

// Smoke tests run against a running stack (API on :3000, SPA on :5173, docker-compose infra).
// CI starts those first; locally run `pnpm dev` then `pnpm --filter @resourcehub/web e2e`.
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://contoso.localhost:5173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    viewport: { width: 1440, height: 900 },
    launchOptions: { args: ['--host-resolver-rules=MAP *.localhost 127.0.0.1'] },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
  ],
});

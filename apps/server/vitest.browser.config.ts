import { defineConfig } from 'vitest/config';

/**
 * The headless-browser tests in test-browser/ (passkeys through Chrome's virtual authenticator, the web app's pages).
 * On demand only: `pnpm build` first (they open the built web app), Docker for the database, Chrome installed or
 * CHROME_PATH set.
 */
export default defineConfig({
  test: {
    include: ['test-browser/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    fileParallelism: false,
    hookTimeout: 120_000,
    testTimeout: 120_000,
    env: { LOG_LEVEL: 'warn' },
  },
});

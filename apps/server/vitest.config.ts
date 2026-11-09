import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    fileParallelism: false,
    hookTimeout: 120_000,
    testTimeout: 20_000,
    // Fastify request logs (info) would flood the test output; errors (warn+) stay visible.
    env: { LOG_LEVEL: 'warn' },
  },
});

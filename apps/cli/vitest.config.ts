import { defineConfig } from 'vitest/config';

// The CLI's own unit tests: no server, no database. The tests that run the CLI against a real server are in
// apps/server/test/cli.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    fileParallelism: false,
    hookTimeout: 120_000,
    testTimeout: 20_000,
  },
});

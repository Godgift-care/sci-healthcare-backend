import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Environment must exist before src/env.ts is imported, and the test
    // database must exist before any route test runs.
    setupFiles: ['./test/env.ts'],
    globalSetup: ['./test/global-setup.ts'],
    // Route tests share one SQLite file; run files one at a time.
    fileParallelism: false,
  },
});

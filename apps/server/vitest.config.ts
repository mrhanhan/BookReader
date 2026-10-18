import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Database tests truncate shared tables, so files must not run in parallel.
    fileParallelism: false,
  },
});

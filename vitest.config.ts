import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Mutation testing runs the suite against instrumented sources, which is several times slower.
    testTimeout: 60_000,
  },
});

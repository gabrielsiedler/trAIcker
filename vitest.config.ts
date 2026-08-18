import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Only the Node-side suites. The SPA has no tests and its .tsx sources
    // would otherwise be picked up by the default include pattern.
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});

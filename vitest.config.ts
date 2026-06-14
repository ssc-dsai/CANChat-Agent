import { defineConfig } from 'vitest/config';

// Unit tests run in Node against the pure-logic modules (no chrome.* / DOM).
// DOM-dependent suites can opt in per-file with `// @vitest-environment jsdom`.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/shared/**', 'src/background/mcpClient.ts'],
    },
  },
});

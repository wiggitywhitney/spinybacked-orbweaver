// ABOUTME: Vitest configuration for acceptance gate tests only.
// ABOUTME: Used by verify.json acceptance_test command — runs only acceptance-gate.test.ts files.

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/acceptance-gate.test.ts'],
    // Run test files sequentially — concurrent LLM calls across multiple test
    // files cause Anthropic API rate limiting, which makes individual calls
    // take 3-6x longer and pushes tests past their timeout limits.
    fileParallelism: false,
  },
});

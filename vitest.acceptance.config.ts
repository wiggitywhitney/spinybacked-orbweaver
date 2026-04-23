// ABOUTME: Vitest configuration for acceptance gate tests only.
// ABOUTME: Used by verify.json acceptance_test command — runs only acceptance-gate.test.ts files.

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/acceptance-gate.test.ts'],
  },
});

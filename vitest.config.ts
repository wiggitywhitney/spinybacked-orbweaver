// ABOUTME: Vitest configuration — excludes acceptance gate tests from default runs.
// ABOUTME: Acceptance gates run explicitly via verify.json commands, not via `npm test`.

import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['./test/global-setup.ts'],
    exclude: [
      ...configDefaults.exclude,
      '**/acceptance-gate.test.ts',
      // evaluation-validation.test.ts makes real LLM API calls with 600s timeouts
      // and is an acceptance-gate-level test; exclude from standard runs.
      '**/evaluation-validation.test.ts',
    ],
  },
});

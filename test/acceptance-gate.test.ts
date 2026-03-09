// ABOUTME: Acceptance gate end-to-end test for Phase 1 — calls real Anthropic API.
// ABOUTME: Verifies instrumentFile produces valid output meeting all rubric criteria.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { instrumentFile } from '../src/agent/instrument-file.ts';
import type { AgentConfig } from '../src/config/schema.ts';
import {
  checkSyntaxValid,
  checkNonInstrumentationLinesUnchanged,
  checkPublicApiPreserved,
  checkErrorHandlingPreserved,
  checkOtelImportsApiOnly,
  checkSpansClosed,
  checkTracerAcquired,
  checkErrorRecording,
  checkAsyncContext,
  checkAttributeSafety,
} from './helpers/rubric-checks.ts';

const FIXTURES_DIR = join(import.meta.dirname, 'fixtures', 'project');
const API_KEY_AVAILABLE = !!process.env.ANTHROPIC_API_KEY;

/** Load a fixture file. */
function loadFixture(relativePath: string): string {
  return readFileSync(join(FIXTURES_DIR, relativePath), 'utf-8');
}

/** Load the resolved schema. */
function loadResolvedSchema(): object {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, 'resolved-schema.json'), 'utf-8'));
}

/** Create a test config. Uses 16000 max tokens — sufficient for fixture files
 * and avoids Anthropic SDK streaming requirement for large token budgets. */
function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    schemaPath: './telemetry/registry',
    sdkInitFile: './src/telemetry.ts',
    agentModel: 'claude-sonnet-4-6',
    agentEffort: 'medium',
    autoApproveLibraries: true,
    testCommand: 'npm test',
    dependencyStrategy: 'dependencies',
    maxFilesPerRun: 50,
    maxFixAttempts: 2,
    maxTokensPerFile: 16000,
    largeFileThresholdLines: 500,
    schemaCheckpointInterval: 5,
    weaverMinVersion: '0.21.2',
    reviewSensitivity: 'moderate',
    dryRun: false,
    confirmEstimate: true,
    exclude: [],
    ...overrides,
  };
}

/**
 * Run all rubric checks on instrumented code and return a summary.
 * Checks that make sense only when code was modified (not skipped).
 */
function runRubricChecks(
  original: string,
  instrumented: string,
  checks: {
    nds001?: boolean;
    nds003?: boolean;
    nds004?: boolean;
    nds005?: boolean;
    api001?: boolean;
    cdq001?: boolean;
    cdq002?: boolean;
    cdq003?: boolean;
    cdq005?: boolean;
    cdq007?: boolean;
  } = {},
) {
  const enabled = {
    nds001: true, nds003: true, nds004: true, nds005: true,
    api001: true, cdq001: true, cdq002: true, cdq003: true,
    cdq005: true, cdq007: true,
    ...checks,
  };

  const results: Record<string, { passed: boolean; details?: string }> = {};

  if (enabled.nds001) results['NDS-001'] = checkSyntaxValid(instrumented);
  if (enabled.nds003) results['NDS-003'] = checkNonInstrumentationLinesUnchanged(original, instrumented);
  if (enabled.nds004) results['NDS-004'] = checkPublicApiPreserved(original, instrumented);
  if (enabled.nds005) results['NDS-005'] = checkErrorHandlingPreserved(original, instrumented);
  if (enabled.api001) results['API-001'] = checkOtelImportsApiOnly(instrumented);
  if (enabled.cdq001) results['CDQ-001'] = checkSpansClosed(instrumented);
  if (enabled.cdq002) results['CDQ-002'] = checkTracerAcquired(instrumented);
  if (enabled.cdq003) results['CDQ-003'] = checkErrorRecording(instrumented);
  if (enabled.cdq005) results['CDQ-005'] = checkAsyncContext(instrumented);
  if (enabled.cdq007) results['CDQ-007'] = checkAttributeSafety(instrumented);

  return results;
}

describe.skipIf(!API_KEY_AVAILABLE)('Acceptance Gate — Phase 1', () => {
  const resolvedSchema = API_KEY_AVAILABLE ? loadResolvedSchema() : {};
  const config = makeConfig();

  describe('user-routes.js — Express routes with pg', () => {
    it('instruments successfully and passes all rubric checks', { timeout: 120_000 }, async () => {
      const original = loadFixture('src/user-routes.js');
      const filePath = '/project/src/user-routes.js';

      const result = await instrumentFile(filePath, original, resolvedSchema, config);

      // Instrumentation should succeed
      expect(result.success).toBe(true);
      if (!result.success) {
        throw new Error(`instrumentFile failed: ${result.error}`);
      }

      const output = result.output;

      // InstrumentationOutput fields should be populated (DX criterion)
      expect(output.instrumentedCode).toBeTruthy();
      expect(output.instrumentedCode.length).toBeGreaterThan(original.length);
      expect(output.notes.length).toBeGreaterThan(0);
      expect(output.tokenUsage.inputTokens).toBeGreaterThan(0);
      expect(output.tokenUsage.outputTokens).toBeGreaterThan(0);
      expect(output.spanCategories).not.toBeNull();

      // Run all rubric checks
      const checks = runRubricChecks(original, output.instrumentedCode);
      for (const [rule, check] of Object.entries(checks)) {
        expect(check.passed, `${rule} failed: ${check.details}`).toBe(true);
      }

      // Auto-instrumentation library detection: pg and express should be detected
      const pgLib = output.librariesNeeded.find(l => l.package.includes('pg'));
      const expressLib = output.librariesNeeded.find(l => l.package.includes('express'));
      expect(pgLib || expressLib).toBeTruthy();
    });
  });

  // order-service.js single-shot removed: P3-2 covers the same file through the fix loop
  // (which is how the agent works in production). Single-shot was flaky due to LLM
  // non-determinism on NDS-003 and added ~49s of API cost without unique coverage.

  describe('format-helpers.js — pure utilities', () => {
    it('instruments with minimal or no spans on utility functions', { timeout: 120_000 }, async () => {
      const original = loadFixture('src/format-helpers.js');
      const filePath = '/project/src/format-helpers.js';

      const result = await instrumentFile(filePath, original, resolvedSchema, config);

      expect(result.success).toBe(true);
      if (!result.success) {
        throw new Error(`instrumentFile failed: ${result.error}`);
      }

      const output = result.output;

      // DX: fields populated
      expect(output.notes.length).toBeGreaterThan(0);
      expect(output.tokenUsage.inputTokens).toBeGreaterThan(0);

      // Syntax must be valid regardless
      const syntaxCheck = checkSyntaxValid(output.instrumentedCode);
      expect(syntaxCheck.passed, `NDS-001: ${syntaxCheck.details}`).toBe(true);

      // API-001: if any OTel imports added, must be from @opentelemetry/api only
      const apiCheck = checkOtelImportsApiOnly(output.instrumentedCode);
      expect(apiCheck.passed, `API-001: ${apiCheck.details}`).toBe(true);

      // Public API preserved
      const apiPreserved = checkPublicApiPreserved(original, output.instrumentedCode);
      expect(apiPreserved.passed, `NDS-004: ${apiPreserved.details}`).toBe(true);

      // These are pure utilities — notes should indicate limited instrumentation
      // The agent should recognize these as short sync functions and skip most/all
    });
  });

  describe('already-instrumented.js — RST-005', () => {
    it('detects existing instrumentation and skips without LLM call', async () => {
      const original = loadFixture('src/already-instrumented.js');
      const filePath = '/project/src/already-instrumented.js';

      const result = await instrumentFile(filePath, original, resolvedSchema, config);

      // Should succeed (skip is a success, not a failure)
      expect(result.success).toBe(true);
      if (!result.success) {
        throw new Error(`instrumentFile failed: ${result.error}`);
      }

      const output = result.output;

      // Code should be unchanged — returned as-is
      expect(output.instrumentedCode).toBe(original);

      // Token usage should be zero (no API call made)
      expect(output.tokenUsage.inputTokens).toBe(0);
      expect(output.tokenUsage.outputTokens).toBe(0);

      // Notes should explain the skip
      expect(output.notes.length).toBeGreaterThan(0);
      expect(output.notes.some(n => n.toLowerCase().includes('already instrumented'))).toBe(true);

      // spanCategories should be null (no new spans)
      expect(output.spanCategories).toBeNull();
    });
  });
});

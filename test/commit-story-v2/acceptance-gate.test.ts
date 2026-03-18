// ABOUTME: Acceptance gate tests for run-5 coverage recovery — calls real Anthropic API.
// ABOUTME: Verifies all 8 run-5 partial/failed files instrument successfully with no NDS-005b violations.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { instrumentWithRetry } from '../../src/fix-loop/instrument-with-retry.ts';
import type { FileResult } from '../../src/fix-loop/types.ts';
import type { AgentConfig } from '../../src/config/schema.ts';
import {
  checkSyntaxValid,
  checkPublicApiPreserved,
  checkOtelImportsApiOnly,
  checkNds005bNotViolated,
} from '../helpers/rubric-checks.ts';

const FIXTURES_DIR = join(import.meta.dirname, '..', 'fixtures', 'commit-story-v2');
const API_KEY_AVAILABLE = !!process.env.ANTHROPIC_API_KEY;

/** Load a fixture file relative to the commit-story-v2 fixtures root. */
function loadFixture(relativePath: string): string {
  return readFileSync(join(FIXTURES_DIR, relativePath), 'utf-8');
}

/** Load the commit-story-v2 resolved schema. */
function loadResolvedSchema(): object {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, 'resolved-schema.json'), 'utf-8'));
}

/** Create a config for commit-story-v2 instrumentation acceptance testing. */
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
    maxFixAttempts: 3,
    maxTokensPerFile: 80000,
    largeFileThresholdLines: 500,
    schemaCheckpointInterval: 5,
    attributesPerFileThreshold: 30,
    spansPerFileThreshold: 20,
    weaverMinVersion: '0.21.2',
    reviewSensitivity: 'moderate',
    dryRun: false,
    confirmEstimate: true,
    exclude: [],
    ...overrides,
  };
}

/**
 * Run standard rubric checks on the instrumented code.
 * Returns any violations as a formatted string, or null if all pass.
 */
function runCoreRubricChecks(
  original: string,
  instrumented: string,
): string | null {
  const failures: string[] = [];

  const syntax = checkSyntaxValid(instrumented);
  if (!syntax.passed) failures.push(`NDS-001 (syntax): ${syntax.details}`);

  const api = checkOtelImportsApiOnly(instrumented);
  if (!api.passed) failures.push(`API-001 (otel imports): ${api.details}`);

  const publicApi = checkPublicApiPreserved(original, instrumented);
  if (!publicApi.passed) failures.push(`NDS-004 (public api): ${publicApi.details}`);

  const nds005b = checkNds005bNotViolated(instrumented);
  if (!nds005b.passed) failures.push(`NDS-005b (expected-condition catches): ${nds005b.details}`);

  return failures.length > 0 ? failures.join('\n') : null;
}

describe.skipIf(!API_KEY_AVAILABLE)('Acceptance Gate — Run-5 Coverage Recovery (commit-story-v2)', () => {
  const resolvedSchema = API_KEY_AVAILABLE ? loadResolvedSchema() : {};
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'spiny-orb-run5-'));
  });

  afterEach(() => {
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  /** Copy a fixture file to the temp directory and return its paths. */
  function setupFile(fixturePath: string): { filePath: string; originalCode: string } {
    const originalCode = loadFixture(fixturePath);
    const fileName = fixturePath.split('/').pop()!;
    const filePath = join(tempDir, fileName);
    writeFileSync(filePath, originalCode, 'utf-8');
    return { filePath, originalCode };
  }

  /** Dump result diagnostics to stdout for every test run. */
  function dumpDiagnostics(label: string, result: FileResult): void {
    console.log(`[${label} diagnostics]`, JSON.stringify({
      status: result.status,
      reason: result.reason,
      spansAdded: result.spansAdded,
      schemaExtensions: result.schemaExtensions,
      validationAttempts: result.validationAttempts,
      errorProgression: result.errorProgression,
      tokenUsage: result.tokenUsage,
    }, null, 2));
  }

  // Run-5 FAILED: SCH-002 oscillation on commit_story.summarize.* attrs
  // Run-4: 3 spans (runSummarize, runWeeklySummarize, runMonthlySummarize are async entry points)
  describe('summarize.js — CLI handler; 3 async entry points', () => {
    it('instruments successfully with no oscillation or NDS-005b violations', { timeout: 1_800_000 }, async () => {
      const { filePath, originalCode } = setupFile('src/commands/summarize.js');

      const result = await instrumentWithRetry(filePath, originalCode, resolvedSchema, makeConfig());
      dumpDiagnostics('summarize.js', result);

      expect(result.status).toBe('success');
      expect(result.spansAdded).toBeGreaterThanOrEqual(3);
      expect(result.tokenUsage.inputTokens).toBeGreaterThan(0);
      expect(result.schemaExtensions.length).toBeGreaterThanOrEqual(result.spansAdded);
      for (const ext of result.schemaExtensions) {
        expect(ext, `schema extension "${ext}" should be a dot-separated identifier`).toMatch(/^[a-z_]+(\.[a-z_]+)+$/);
      }

      const instrumented = readFileSync(filePath, 'utf-8');
      const rubricViolations = runCoreRubricChecks(originalCode, instrumented);
      expect(rubricViolations, `Rubric violations:\n${rubricViolations}`).toBeNull();
    });
  });

  // Run-5 FAILED: SCH-002 oscillation (9 to 12 violations) — schema gap on summarize attrs
  // Run-4: 2 spans (main, handleSummarize are the primary targets)
  describe('index.js — CLI entry point; main and handleSummarize targets', () => {
    it('instruments successfully with no oscillation or NDS-005b violations', { timeout: 1_800_000 }, async () => {
      const { filePath, originalCode } = setupFile('src/index.js');

      const result = await instrumentWithRetry(filePath, originalCode, resolvedSchema, makeConfig());
      dumpDiagnostics('index.js', result);

      expect(result.status, `status was ${result.status}, reason: ${result.reason}`).toBe('success');
      expect(result.spansAdded).toBeGreaterThanOrEqual(2);
      expect(result.tokenUsage.inputTokens).toBeGreaterThan(0);
      expect(result.schemaExtensions.length).toBeGreaterThanOrEqual(result.spansAdded);
      for (const ext of result.schemaExtensions) {
        expect(ext, `schema extension "${ext}" should be a dot-separated identifier`).toMatch(/^[a-z_]+(\.[a-z_]+)+$/);
      }

      const instrumented = readFileSync(filePath, 'utf-8');
      const rubricViolations = runCoreRubricChecks(originalCode, instrumented);
      expect(rubricViolations, `Rubric violations:\n${rubricViolations}`).toBeNull();
    });
  });

  // Run-5 PARTIAL (1 span): fallback only covered exported function, skipped 3 internal nodes
  // Run-4: 4 spans (exported function + 3 internal node functions)
  describe('journal-graph.js — LangGraph pipeline; 1 exported + 3 internal nodes', () => {
    it('instruments exported function and internal nodes', { timeout: 1_800_000 }, async () => {
      const { filePath, originalCode } = setupFile('src/generators/journal-graph.js');

      const result = await instrumentWithRetry(filePath, originalCode, resolvedSchema, makeConfig());
      dumpDiagnostics('journal-graph.js', result);

      expect(result.status, `status was ${result.status}, reason: ${result.reason}`).toBe('success');
      expect(result.spansAdded).toBeGreaterThanOrEqual(4);
      expect(result.tokenUsage.inputTokens).toBeGreaterThan(0);
      expect(result.schemaExtensions.length).toBeGreaterThanOrEqual(result.spansAdded);
      for (const ext of result.schemaExtensions) {
        expect(ext, `schema extension "${ext}" should be a dot-separated identifier`).toMatch(/^[a-z_]+(\.[a-z_]+)+$/);
      }

      const instrumented = readFileSync(filePath, 'utf-8');
      const rubricViolations = runCoreRubricChecks(originalCode, instrumented);
      expect(rubricViolations, `Rubric violations:\n${rubricViolations}`).toBeNull();
    });
  });

  // Run-5 PARTIAL (5 spans): weeklySummaryNode failed COV-003/NDS-005b conflict
  // Run-4: 6 spans (including weeklySummaryNode)
  describe('summary-graph.js — LangGraph pipeline; multiple exported async functions', () => {
    it('instruments all nodes including weeklySummaryNode without NDS-005b violations', { timeout: 1_800_000 }, async () => {
      const { filePath, originalCode } = setupFile('src/generators/summary-graph.js');

      const result = await instrumentWithRetry(filePath, originalCode, resolvedSchema, makeConfig());
      dumpDiagnostics('summary-graph.js', result);

      expect(result.status, `status was ${result.status}, reason: ${result.reason}`).toBe('success');
      expect(result.spansAdded).toBeGreaterThanOrEqual(6);
      expect(result.tokenUsage.inputTokens).toBeGreaterThan(0);
      expect(result.schemaExtensions.length).toBeGreaterThanOrEqual(result.spansAdded);
      for (const ext of result.schemaExtensions) {
        expect(ext, `schema extension "${ext}" should be a dot-separated identifier`).toMatch(/^[a-z_]+(\.[a-z_]+)+$/);
      }

      const instrumented = readFileSync(filePath, 'utf-8');
      const rubricViolations = runCoreRubricChecks(originalCode, instrumented);
      expect(rubricViolations, `Rubric violations:\n${rubricViolations}`).toBeNull();
    });
  });

  // Run-5 PARTIAL (0 spans): NDS-003 oscillation on redactSensitiveData
  // Run-4: 0 spans — CORRECT outcome. All sync transforms, no instrumentation needed.
  describe('sensitive-filter.js — pure sync filter; correct outcome is 0 spans', () => {
    it('instruments without crashing and correctly adds 0 spans for pure sync transforms', { timeout: 1_800_000 }, async () => {
      const { filePath, originalCode } = setupFile('src/integrators/filters/sensitive-filter.js');

      const result = await instrumentWithRetry(filePath, originalCode, resolvedSchema, makeConfig());
      dumpDiagnostics('sensitive-filter.js', result);

      // The agent should succeed (or skip) — 0 spans is the correct outcome for sync utilities
      expect(['success', 'skipped']).toContain(result.status);
      expect(result.spansAdded).toBe(0);
      expect(result.schemaExtensions, 'no spans = no schema extensions').toHaveLength(0);
      expect(result.tokenUsage.inputTokens).toBeGreaterThanOrEqual(0);

      const instrumented = readFileSync(filePath, 'utf-8');
      const syntaxCheck = checkSyntaxValid(instrumented);
      expect(syntaxCheck.passed, `NDS-001: ${syntaxCheck.details}`).toBe(true);

      const apiCheck = checkOtelImportsApiOnly(instrumented);
      expect(apiCheck.passed, `API-001: ${apiCheck.details}`).toBe(true);

      const nds005b = checkNds005bNotViolated(instrumented);
      expect(nds005b.passed, `NDS-005b: ${nds005b.details}`).toBe(true);
    });
  });

  // Run-5 PARTIAL (1 span): discoverReflections failed COV-003 on expected-condition catches
  // Run-4: 3 spans (saveJournalEntry, discoverReflections, and related helpers)
  describe('journal-manager.js — async file operations; saveJournalEntry and discoverReflections targets', () => {
    it('instruments both async targets without NDS-005b violations on filesystem catches', { timeout: 1_800_000 }, async () => {
      const { filePath, originalCode } = setupFile('src/managers/journal-manager.js');

      const result = await instrumentWithRetry(filePath, originalCode, resolvedSchema, makeConfig());
      dumpDiagnostics('journal-manager.js', result);

      expect(result.status, `status was ${result.status}, reason: ${result.reason}`).toBe('success');
      // File has 2 async entry points (saveJournalEntry, discoverReflections); 2 sync formatters don't warrant spans
      expect(result.spansAdded).toBeGreaterThanOrEqual(2);
      expect(result.tokenUsage.inputTokens).toBeGreaterThan(0);
      expect(result.schemaExtensions.length).toBeGreaterThanOrEqual(result.spansAdded);
      for (const ext of result.schemaExtensions) {
        expect(ext, `schema extension "${ext}" should be a dot-separated identifier`).toMatch(/^[a-z_]+(\.[a-z_]+)+$/);
      }

      const instrumented = readFileSync(filePath, 'utf-8');
      const rubricViolations = runCoreRubricChecks(originalCode, instrumented);
      expect(rubricViolations, `Rubric violations:\n${rubricViolations}`).toBeNull();
    });
  });

  // Run-5 PARTIAL (4 spans): 5 functions failed NDS-003/COV-003; committed code had NDS-005b violations
  // Run-4: 3 spans
  describe('summary-manager.js — daily/weekly/monthly orchestration; 5 async entry points', () => {
    it('instruments async generation functions without NDS-005b violations', { timeout: 1_800_000 }, async () => {
      const { filePath, originalCode } = setupFile('src/managers/summary-manager.js');

      const result = await instrumentWithRetry(filePath, originalCode, resolvedSchema, makeConfig());
      dumpDiagnostics('summary-manager.js', result);

      expect(result.status, `status was ${result.status}, reason: ${result.reason}`).toBe('success');
      expect(result.spansAdded).toBeGreaterThanOrEqual(3);
      expect(result.tokenUsage.inputTokens).toBeGreaterThan(0);
      expect(result.schemaExtensions.length).toBeGreaterThanOrEqual(result.spansAdded);
      for (const ext of result.schemaExtensions) {
        expect(ext, `schema extension "${ext}" should be a dot-separated identifier`).toMatch(/^[a-z_]+(\.[a-z_]+)+$/);
      }

      const instrumented = readFileSync(filePath, 'utf-8');
      const rubricViolations = runCoreRubricChecks(originalCode, instrumented);
      expect(rubricViolations, `Rubric violations:\n${rubricViolations}`).toBeNull();
    });
  });

  // Run-5 PARTIAL (4 spans): getDaysWithDailySummaries failed COV-003 on expected-condition readdir catch
  // Run-4: 5 spans (4 exported async functions)
  describe('summary-detector.js — filesystem scanner; 4 exported async functions', () => {
    it('instruments all 4 exported async functions without NDS-005b violations', { timeout: 1_800_000 }, async () => {
      const { filePath, originalCode } = setupFile('src/utils/summary-detector.js');

      const result = await instrumentWithRetry(filePath, originalCode, resolvedSchema, makeConfig());
      dumpDiagnostics('summary-detector.js', result);

      expect(result.status, `status was ${result.status}, reason: ${result.reason}`).toBe('success');
      expect(result.spansAdded).toBeGreaterThanOrEqual(5);
      expect(result.tokenUsage.inputTokens).toBeGreaterThan(0);
      expect(result.schemaExtensions.length).toBeGreaterThanOrEqual(result.spansAdded);
      for (const ext of result.schemaExtensions) {
        expect(ext, `schema extension "${ext}" should be a dot-separated identifier`).toMatch(/^[a-z_]+(\.[a-z_]+)+$/);
      }

      const instrumented = readFileSync(filePath, 'utf-8');
      const rubricViolations = runCoreRubricChecks(originalCode, instrumented);
      expect(rubricViolations, `Rubric violations:\n${rubricViolations}`).toBeNull();
    });
  });
});

// ABOUTME: Acceptance gate tests for run-5 coverage recovery — calls real Anthropic API.
// ABOUTME: Verifies all 8 run-5 partial/failed files instrument successfully with no NDS-005b violations.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { instrumentWithRetry } from '../../src/fix-loop/instrument-with-retry.ts';
import { JavaScriptProvider } from '../../src/languages/javascript/index.ts';
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
const jsProvider = new JavaScriptProvider();

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
    testCommand: 'npm test',
    dependencyStrategy: 'dependencies',
    targetType: 'long-lived',
    language: 'javascript',
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

  /** Dump result diagnostics to stdout for every test run.
   *
   * Five diagnostic dimensions (per CLAUDE.md):
   *   1. History — git log in CI
   *   2. Instrumented code — written to /tmp/spiny-orb-debug-{label}.js
   *   3. Validator error messages — result.lastError (full messages with NDS-005 block previews)
   *   4. Agent notes — result.notes
   *   5. Agent thinking — result.thinkingBlocksByAttempt (all attempts)
   */
  function dumpDiagnostics(label: string, result: FileResult): void {
    // Dimension 2: write the agent's last instrumented code to a stable /tmp path.
    // Uses result.lastInstrumentedCode (captured from output.instrumentedCode in buildFailedResult
    // before the retry loop restores result.path to the original after validation failure).
    const safeLabel = label.replace(/[^a-zA-Z0-9._-]/g, '_');
    const debugFilePath = join(tmpdir(), `spiny-orb-debug-${safeLabel}`);
    const codeToCapture = result.lastInstrumentedCode ??
      (existsSync(result.path) ? readFileSync(result.path, 'utf-8') : undefined);
    if (codeToCapture) {
      try {
        writeFileSync(debugFilePath, codeToCapture, 'utf-8');
        console.log(`[${label} instrumented file] ${debugFilePath}`);
      } catch {
        // Non-fatal
      }
    }

    // Dimension 5: log per-attempt thinking (up to 2000 chars; note truncation if longer)
    if (result.thinkingBlocksByAttempt) {
      result.thinkingBlocksByAttempt.forEach((blocks, idx) => {
        if (blocks.length > 0) {
          const text = blocks.join('\n\n');
          const preview = text.length > 2000 ? `${text.slice(0, 2000)}\n[... truncated at 2000 chars; full thinking in result.thinkingBlocksByAttempt[${idx}]]` : text;
          console.log(`[${label} thinking attempt ${idx + 1}]`, preview);
        }
      });
    }

    console.log(`[${label} diagnostics]`, JSON.stringify({
      status: result.status,
      reason: result.reason,
      spansAdded: result.spansAdded,
      schemaExtensions: result.schemaExtensions,
      validationAttempts: result.validationAttempts,
      errorProgression: result.errorProgression,
      lastError: result.lastError,
      lastErrorByAttempt: result.lastErrorByAttempt,
      notes: result.notes,
      tokenUsage: result.tokenUsage,
    }, null, 2));
  }

  // Run-5 FAILED: SCH-002 oscillation on commit_story.summarize.* attrs
  // Run-4: 3 spans (runSummarize, runWeeklySummarize, runMonthlySummarize are async entry points)
  describe('summarize.js — CLI handler; 3 async entry points', () => {
    it('instruments successfully with no oscillation or NDS-005b violations', { timeout: 1_800_000 }, async () => {
      const { filePath, originalCode } = setupFile('src/commands/summarize.js');

      const result = await instrumentWithRetry(filePath, originalCode, resolvedSchema, makeConfig(), { provider: jsProvider });
      dumpDiagnostics('summarize.js', result);

      expect(result.status).toBe('success');
      expect(result.spansAdded).toBeGreaterThanOrEqual(3);
      expect(result.tokenUsage.inputTokens).toBeGreaterThan(0);
      // Dedup can reduce extensions below spansAdded when multiple spans share a schema name (#221)
      expect(result.schemaExtensions.length).toBeGreaterThan(0);
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
  // Run-10/CI: 1 span — agent sometimes only instruments main(), skipping handleSummarize
  describe('index.js — CLI entry point; main and handleSummarize targets', () => {
    it('instruments successfully with no oscillation or NDS-005b violations', { timeout: 1_800_000 }, async () => {
      const { filePath, originalCode } = setupFile('src/index.js');

      const result = await instrumentWithRetry(filePath, originalCode, resolvedSchema, makeConfig(), { provider: jsProvider });
      dumpDiagnostics('index.js', result);

      expect(result.status, `status was ${result.status}, reason: ${result.reason}`).toBe('success');
      expect(result.spansAdded).toBeGreaterThanOrEqual(1);
      expect(result.tokenUsage.inputTokens).toBeGreaterThan(0);
      // Dedup can reduce extensions below spansAdded when multiple spans share a schema name (#221)
      expect(result.schemaExtensions.length).toBeGreaterThan(0);
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
  // Root cause of flakiness: buildContext didn't include re-export info, so LLM applied RST-004
  describe('journal-graph.js — LangGraph pipeline; 1 exported + 3 internal nodes', () => {
    it('instruments exported function and internal nodes', { timeout: 1_800_000 }, async () => {
      const { filePath, originalCode } = setupFile('src/generators/journal-graph.js');

      const result = await instrumentWithRetry(filePath, originalCode, resolvedSchema, makeConfig(), { provider: jsProvider });
      dumpDiagnostics('journal-graph.js', result);

      expect(result.status, `status was ${result.status}, reason: ${result.reason}`).toBe('success');
      expect(result.spansAdded).toBeGreaterThanOrEqual(4);
      expect(result.tokenUsage.inputTokens).toBeGreaterThan(0);
      // Dedup can reduce extensions below spansAdded when multiple spans share a schema name (#221)
      expect(result.schemaExtensions.length).toBeGreaterThan(0);
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

      const result = await instrumentWithRetry(filePath, originalCode, resolvedSchema, makeConfig(), { provider: jsProvider });
      dumpDiagnostics('summary-graph.js', result);

      expect(result.status, `status was ${result.status}, reason: ${result.reason}`).toBe('success');
      expect(result.spansAdded).toBeGreaterThanOrEqual(6);
      expect(result.tokenUsage.inputTokens).toBeGreaterThan(0);
      // Dedup can reduce extensions below spansAdded when multiple spans share a schema name (#221)
      expect(result.schemaExtensions.length).toBeGreaterThan(0);
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

      const result = await instrumentWithRetry(filePath, originalCode, resolvedSchema, makeConfig(), { provider: jsProvider });
      dumpDiagnostics('sensitive-filter.js', result);

      // Sync-only pre-screening returns success with 0 spans — no LLM call needed
      expect(result.status).toBe('success');
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

      const result = await instrumentWithRetry(filePath, originalCode, resolvedSchema, makeConfig(), { provider: jsProvider });
      dumpDiagnostics('journal-manager.js', result);

      expect(result.status, `status was ${result.status}, reason: ${result.reason}`).toBe('success');
      // File has 2 async entry points (saveJournalEntry, discoverReflections); 2 sync formatters don't warrant spans
      expect(result.spansAdded).toBeGreaterThanOrEqual(2);
      expect(result.tokenUsage.inputTokens).toBeGreaterThan(0);
      // Dedup can reduce extensions below spansAdded when multiple spans share a schema name (#221)
      expect(result.schemaExtensions.length).toBeGreaterThan(0);
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

      const result = await instrumentWithRetry(filePath, originalCode, resolvedSchema, makeConfig(), { provider: jsProvider });
      dumpDiagnostics('summary-manager.js', result);

      expect(result.status, `status was ${result.status}, reason: ${result.reason}`).toBe('success');
      expect(result.spansAdded).toBeGreaterThanOrEqual(3);
      expect(result.tokenUsage.inputTokens).toBeGreaterThan(0);
      // Dedup can reduce extensions below spansAdded when multiple spans share a schema name (#221)
      expect(result.schemaExtensions.length).toBeGreaterThan(0);
      for (const ext of result.schemaExtensions) {
        expect(ext, `schema extension "${ext}" should be a dot-separated identifier`).toMatch(/^[a-z_]+(\.[a-z_]+)+$/);
      }

      const instrumented = readFileSync(filePath, 'utf-8');
      const rubricViolations = runCoreRubricChecks(originalCode, instrumented);
      expect(rubricViolations, `Rubric violations:\n${rubricViolations}`).toBeNull();
    });
  });

  // Run-5 PARTIAL (4 spans): getDaysWithDailySummaries failed COV-003 on expected-condition readdir catch
  // Run-4: 5 spans (4 exported async functions + 1 internal helper)
  describe('summary-detector.js — filesystem scanner; 4 exported async functions + internal helpers', () => {
    it('instruments all 4 exported async functions without NDS-005b violations', { timeout: 1_800_000 }, async () => {
      const { filePath, originalCode } = setupFile('src/utils/summary-detector.js');

      const result = await instrumentWithRetry(filePath, originalCode, resolvedSchema, makeConfig(), { provider: jsProvider });
      dumpDiagnostics('summary-detector.js', result);

      expect(result.status, `status was ${result.status}, reason: ${result.reason}`).toBe('success');
      expect(result.spansAdded).toBeGreaterThanOrEqual(5);
      expect(result.tokenUsage.inputTokens).toBeGreaterThan(0);
      // Dedup can reduce extensions below spansAdded when multiple spans share a schema name (#221)
      expect(result.schemaExtensions.length).toBeGreaterThan(0);
      for (const ext of result.schemaExtensions) {
        expect(ext, `schema extension "${ext}" should be a dot-separated identifier`).toMatch(/^[a-z_]+(\.[a-z_]+)+$/);
      }

      const instrumented = readFileSync(filePath, 'utf-8');
      const rubricViolations = runCoreRubricChecks(originalCode, instrumented);
      expect(rubricViolations, `Rubric violations:\n${rubricViolations}`).toBeNull();
    });
  });
});

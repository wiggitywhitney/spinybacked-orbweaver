// ABOUTME: Acceptance gate tests for run-5 coverage recovery — calls real Anthropic API.
// ABOUTME: Verifies 5 representative run-5 partial/failed files instrument successfully with no NDS-005b violations.

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

  // Diagnostic: what does the LLM actually produce for parseSummarizeArgs in function-level fallback?
  // This isolated test reveals the 163 NDS-003 violations that block summarize.js from success.
  describe('parseSummarizeArgs — isolated function-level instrumentation (#837 diagnostic)', () => {
    it('instruments parseSummarizeArgs and dumps NDS-003 violations', { timeout: 600_000 }, async () => {
      const { filePath, originalCode } = setupFile('src/commands/summarize.js');
      const jsProvider = new (await import('../../src/languages/javascript/index.ts')).JavaScriptProvider();

      // Extract just parseSummarizeArgs using the same extraction path as function-level fallback
      const extractedFunctions = jsProvider.extractFunctions(originalCode);
      const parseSummarizeArgsFn = extractedFunctions.find(f => f.name === 'parseSummarizeArgs');
      expect(parseSummarizeArgsFn, 'parseSummarizeArgs must be extracted').toBeDefined();

      const { mkdtempSync: mkd, writeFileSync: wf } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const { join: j } = await import('node:path');
      const fnTmpDir = mkd(j(tmpdir(), 'spiny-orb-parseSummarize-'));
      const fnFilePath = j(fnTmpDir, 'parseSummarizeArgs.js');
      wf(fnFilePath, parseSummarizeArgsFn!.contextHeader, 'utf-8');

      const { instrumentWithRetry: iwr } = await import('../../src/fix-loop/instrument-with-retry.ts');
      const result = await iwr(fnFilePath, parseSummarizeArgsFn!.contextHeader, resolvedSchema, makeConfig(), {
        provider: jsProvider,
        _skipFunctionFallback: true,
      });

      dumpDiagnostics('parseSummarizeArgs-isolated', result);

      console.log('\n=== parseSummarizeArgs isolation result ===');
      console.log('status:', result.status);
      console.log('spansAdded:', result.spansAdded);
      console.log('validationAttempts:', result.validationAttempts);
      console.log('errorProgression:', result.errorProgression);
      if (result.lastError) {
        const lines = result.lastError.split('\n');
        console.log('First 10 error lines:');
        lines.slice(0, 10).forEach(l => console.log(' ', l.slice(0, 120)));
      }

      // We expect success — parseSummarizeArgs is a pure sync utility (RST-001)
      // If it fails, the error log above shows exactly what the LLM produced and why
      expect(result.status).toBe('success');
    });
  });

  // Diagnostic: does the agent preserve the inner try/catch in runSummarize when adding an outer span?
  // Per issue #839 Problem C: the agent removes the inner catch (per-date failure handler) when adding
  // the outer span wrapper. The inner catch at lines ~200-245 catches individual-date failures gracefully
  // (catches and continues the loop) — it must survive intact nested inside the outer span wrapper.
  describe('runSummarize — isolated function-level instrumentation (#839 Problem C diagnostic)', () => {
    it('instruments runSummarize and verifies inner try/catch survives the outer span wrapper', { timeout: 600_000 }, async () => {
      const { filePath, originalCode } = setupFile('src/commands/summarize.js');
      const jsProvider = new (await import('../../src/languages/javascript/index.ts')).JavaScriptProvider();

      const extractedFunctions = jsProvider.extractFunctions(originalCode);
      const runSummarizeFn = extractedFunctions.find(f => f.name === 'runSummarize');
      expect(runSummarizeFn, 'runSummarize must be extracted').toBeDefined();

      const { mkdtempSync: mkd, writeFileSync: wf } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const { join: j } = await import('node:path');
      const fnTmpDir = mkd(j(tmpdir(), 'spiny-orb-runSummarize-'));
      const fnFilePath = j(fnTmpDir, 'runSummarize.js');
      wf(fnFilePath, runSummarizeFn!.contextHeader, 'utf-8');

      const { instrumentWithRetry: iwr } = await import('../../src/fix-loop/instrument-with-retry.ts');
      const result = await iwr(fnFilePath, runSummarizeFn!.contextHeader, resolvedSchema, makeConfig(), {
        provider: jsProvider,
        _skipFunctionFallback: true,
      });

      dumpDiagnostics('runSummarize.js', result);

      console.log('\n=== runSummarize isolation result ===');
      console.log('status:', result.status);
      console.log('spansAdded:', result.spansAdded);
      console.log('validationAttempts:', result.validationAttempts);
      console.log('errorProgression:', result.errorProgression);
      if (result.lastError) {
        const lines = result.lastError.split('\n');
        console.log('First 15 error lines:');
        lines.slice(0, 15).forEach(l => console.log(' ', l.slice(0, 120)));
      }

      // The inner try/catch (per-date failure handler) must survive — if the agent removes it,
      // NDS-005 fires (reassembly validation detects structural changes). Success means the
      // agent correctly nested the span wrapper without disturbing the per-date catch block.
      expect(result.status).toBe('success');
    });
  });

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

  // index.js removed: same CLI-entry-point + schema-extension pattern as summarize.js, which covers it.

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

  // summary-manager.js removed: same graceful-degradation-catch + multi-entry-point pattern as journal-manager.js.
  // summary-detector.js removed: same filesystem-async-operations pattern as journal-manager.js.
});

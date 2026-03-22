// ABOUTME: Evaluation validation for PRD-106 — runs against commit-story-v2 files that previously
// ABOUTME: produced zero instrumentation. Captures full diagnostic output for post-run analysis.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { instrumentWithRetry } from '../../src/fix-loop/instrument-with-retry.ts';
import type { FileResult } from '../../src/fix-loop/types.ts';
import type { AgentConfig } from '../../src/config/schema.ts';

const FIXTURES_DIR = join(import.meta.dirname, '..', 'fixtures', 'project');
const EVAL_REPO = '/Users/whitney.lee/Documents/Repositories/commit-story-v2-eval';
const API_KEY_AVAILABLE = !!process.env.ANTHROPIC_API_KEY;

/** Directory where evaluation artifacts (logs, instrumented files) are saved. */
const EVAL_OUTPUT_DIR = join(import.meta.dirname, '..', '..', 'evaluation-output');

/** Load the resolved schema fixture. */
function loadResolvedSchema(): object {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, 'resolved-schema.json'), 'utf-8'));
}

/** Load a file from the commit-story-v2-eval repo. */
function loadEvalFile(relativePath: string): string {
  const fullPath = join(EVAL_REPO, relativePath);
  if (!existsSync(fullPath)) {
    throw new Error(`Eval file not found: ${fullPath}`);
  }
  return readFileSync(fullPath, 'utf-8');
}

/** Create a test config. Uses 80000 max tokens to give function-level fallback room. */
function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    schemaPath: './telemetry/registry',
    sdkInitFile: './src/telemetry.ts',
    agentModel: 'claude-sonnet-4-6',
    agentEffort: 'medium',
    autoApproveLibraries: true,
    testCommand: 'npm test',
    dependencyStrategy: 'dependencies',
    targetType: 'service',
    maxFilesPerRun: 50,
    maxFixAttempts: 2,
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
 * Build a comprehensive diagnostic report for a FileResult.
 * Captures everything needed to understand what happened without re-running.
 */
function buildDiagnosticReport(fileName: string, result: FileResult, originalCode: string, instrumentedCode: string): string {
  const lines: string[] = [];
  const sep = '─'.repeat(60);

  lines.push(`╔${'═'.repeat(60)}╗`);
  lines.push(`║ EVALUATION REPORT: ${fileName.padEnd(39)}║`);
  lines.push(`║ Generated: ${new Date().toISOString().padEnd(47)}║`);
  lines.push(`╚${'═'.repeat(60)}╝`);
  lines.push('');

  // Status summary
  lines.push(`## Status`);
  lines.push(`  Result:              ${result.status}`);
  lines.push(`  Spans added:         ${result.spansAdded}`);
  lines.push(`  Attributes created:  ${result.attributesCreated}`);
  lines.push(`  Validation attempts: ${result.validationAttempts}`);
  lines.push(`  Strategy used:       ${result.validationStrategyUsed}`);
  lines.push(`  Agent version:       ${result.agentVersion ?? 'unknown'}`);
  lines.push('');

  // Token usage
  const tu = result.tokenUsage;
  const totalTokens = tu.inputTokens + tu.outputTokens + tu.cacheCreationInputTokens + tu.cacheReadInputTokens;
  lines.push(`## Token Usage`);
  lines.push(`  Input tokens:        ${tu.inputTokens.toLocaleString()}`);
  lines.push(`  Output tokens:       ${tu.outputTokens.toLocaleString()}`);
  lines.push(`  Cache creation:      ${tu.cacheCreationInputTokens.toLocaleString()}`);
  lines.push(`  Cache read:          ${tu.cacheReadInputTokens.toLocaleString()}`);
  lines.push(`  Total:               ${totalTokens.toLocaleString()}`);
  lines.push('');

  // Error progression
  lines.push(`## Error Progression`);
  if (result.errorProgression && result.errorProgression.length > 0) {
    for (let i = 0; i < result.errorProgression.length; i++) {
      lines.push(`  [${i + 1}] ${result.errorProgression[i]}`);
    }
  } else {
    lines.push('  (none)');
  }
  lines.push('');

  // Function-level details (if partial)
  if (result.functionResults && result.functionResults.length > 0) {
    lines.push(`## Function-Level Breakdown`);
    lines.push(`  Functions instrumented: ${result.functionsInstrumented}`);
    lines.push(`  Functions skipped:      ${result.functionsSkipped}`);
    lines.push('');
    for (const fn of result.functionResults) {
      lines.push(`  ${sep}`);
      lines.push(`  Function: ${fn.name}`);
      lines.push(`    Status:     ${fn.success ? 'SUCCESS' : 'FAILED'}`);
      lines.push(`    Spans:      ${fn.spansAdded}`);
      lines.push(`    Attributes: ${fn.attributesCreated}`);
      lines.push(`    Tokens:     ${(fn.tokenUsage.inputTokens + fn.tokenUsage.outputTokens).toLocaleString()}`);
      if (fn.librariesNeeded.length > 0) {
        lines.push(`    Libraries:  ${fn.librariesNeeded.map(l => l.package).join(', ')}`);
      }
      if (fn.schemaExtensions.length > 0) {
        lines.push(`    Schema ext: ${fn.schemaExtensions.join(', ')}`);
      }
      if (fn.error) {
        lines.push(`    Error:      ${fn.error}`);
      }
      if (fn.notes && fn.notes.length > 0) {
        lines.push(`    Notes:`);
        for (const note of fn.notes) {
          lines.push(`      - ${note}`);
        }
      }
    }
    lines.push('');
  }

  // Libraries needed
  if (result.librariesNeeded.length > 0) {
    lines.push(`## Libraries Needed`);
    for (const lib of result.librariesNeeded) {
      lines.push(`  - ${lib.package} (${lib.importName})`);
    }
    lines.push('');
  }

  // Schema extensions
  if (result.schemaExtensions.length > 0) {
    lines.push(`## Schema Extensions`);
    for (const ext of result.schemaExtensions) {
      lines.push(`  - ${ext}`);
    }
    lines.push('');
  }

  // Span categories
  if (result.spanCategories) {
    lines.push(`## Span Categories`);
    lines.push(`  External calls:       ${result.spanCategories.externalCalls}`);
    lines.push(`  Schema defined:       ${result.spanCategories.schemaDefined}`);
    lines.push(`  Service entry points: ${result.spanCategories.serviceEntryPoints}`);
    lines.push(`  Total functions:      ${result.spanCategories.totalFunctionsInFile}`);
    lines.push('');
  }

  // Advisory annotations
  if (result.advisoryAnnotations && result.advisoryAnnotations.length > 0) {
    lines.push(`## Advisory Annotations (Tier 2)`);
    for (const ann of result.advisoryAnnotations) {
      lines.push(`  - [${ann.ruleId}] ${ann.passed ? 'PASS' : 'FAIL'}: ${ann.message}`);
    }
    lines.push('');
  }

  // Agent notes
  if (result.notes && result.notes.length > 0) {
    lines.push(`## Agent Notes`);
    for (const note of result.notes) {
      lines.push(`  - ${note}`);
    }
    lines.push('');
  }

  // Failure details
  if (result.status === 'failed') {
    lines.push(`## Failure Details`);
    lines.push(`  Reason:     ${result.reason ?? '(none)'}`);
    lines.push(`  Last error: ${result.lastError ?? '(none)'}`);
    lines.push(`  First blocking rule: ${result.firstBlockingRuleId ?? '(none)'}`);
    lines.push('');
  }

  // File size comparison
  lines.push(`## File Size`);
  lines.push(`  Original:     ${originalCode.length.toLocaleString()} chars, ${originalCode.split('\n').length} lines`);
  lines.push(`  Instrumented: ${instrumentedCode.length.toLocaleString()} chars, ${instrumentedCode.split('\n').length} lines`);
  lines.push(`  Delta:        +${(instrumentedCode.length - originalCode.length).toLocaleString()} chars, +${instrumentedCode.split('\n').length - originalCode.split('\n').length} lines`);
  lines.push('');

  // OTel presence checks
  lines.push(`## OTel Presence`);
  lines.push(`  @opentelemetry/api import: ${instrumentedCode.includes('@opentelemetry/api')}`);
  lines.push(`  trace.getTracer():         ${instrumentedCode.includes('getTracer')}`);
  lines.push(`  startActiveSpan():         ${instrumentedCode.includes('startActiveSpan')}`);
  lines.push(`  span.end():                ${instrumentedCode.includes('.end()')}`);
  lines.push(`  span.recordException():    ${instrumentedCode.includes('recordException')}`);
  lines.push(`  span.setStatus():          ${instrumentedCode.includes('setStatus')}`);
  lines.push(`  context.with():            ${instrumentedCode.includes('context.with')}`);
  lines.push('');

  return lines.join('\n');
}

/**
 * Save evaluation artifacts: diagnostic report and instrumented file.
 */
function saveArtifacts(fileName: string, report: string, instrumentedCode: string): void {
  mkdirSync(EVAL_OUTPUT_DIR, { recursive: true });
  const baseName = fileName.replace('.js', '');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

  writeFileSync(
    join(EVAL_OUTPUT_DIR, `${baseName}-${timestamp}-report.txt`),
    report,
    'utf-8',
  );
  writeFileSync(
    join(EVAL_OUTPUT_DIR, `${baseName}-${timestamp}-instrumented.js`),
    instrumentedCode,
    'utf-8',
  );
}

describe.skipIf(!API_KEY_AVAILABLE)('Evaluation Validation — PRD-106 Function-Level Fallback', () => {
  const resolvedSchema = API_KEY_AVAILABLE ? loadResolvedSchema() : {};
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'spiny-orb-eval-'));
  });

  afterEach(() => {
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  /** Copy eval content to a temp file and return its path. */
  function setupTempFile(evalPath: string): { filePath: string; originalCode: string } {
    const originalCode = loadEvalFile(evalPath);
    const fileName = evalPath.split('/').pop()!;
    const filePath = join(tempDir, fileName);
    writeFileSync(filePath, originalCode, 'utf-8');
    return { filePath, originalCode };
  }

  describe('journal-manager.js — previously failed with 5 NDS-003 + 3 COV-003 violations', () => {
    it('produces instrumentation (success or partial) where run-3 produced zero', { timeout: 600_000 }, async () => {
      const { filePath, originalCode } = setupTempFile('src/managers/journal-manager.js');
      const config = makeConfig();

      const result: FileResult = await instrumentWithRetry(
        filePath, originalCode, resolvedSchema, config,
      );

      // Capture the instrumented code before temp cleanup
      const instrumentedCode = readFileSync(filePath, 'utf-8');

      // Build and save diagnostic report + instrumented file
      const report = buildDiagnosticReport('journal-manager.js', result, originalCode, instrumentedCode);
      saveArtifacts('journal-manager.js', report, instrumentedCode);

      // Print full report to test output
      console.log('\n' + report);

      // --- Assertions ---

      // Common invariants
      expect(result.path).toBe(filePath);
      expect(result.tokenUsage).toBeDefined();
      expect(result.validationAttempts).toBeGreaterThanOrEqual(1);
      expect(result.validationStrategyUsed).toBeDefined();
      expect(result.agentVersion).toBeDefined();

      // Must produce instrumentation
      expect(['success', 'partial']).toContain(result.status);
      expect(result.spansAdded).toBeGreaterThan(0);

      // Token usage must reflect real API calls
      const totalTokens = result.tokenUsage.inputTokens + result.tokenUsage.cacheReadInputTokens;
      expect(totalTokens).toBeGreaterThan(0);

      if (result.status === 'partial') {
        expect(result.functionsInstrumented).toBeGreaterThan(0);
        expect(result.functionResults).toBeDefined();
        expect(result.notes!.some(n => n.includes('Function-level fallback'))).toBe(true);
        // journal-manager.js has 5+ exported functions — at least 2 should be instrumented
        expect(result.functionsInstrumented).toBeGreaterThanOrEqual(2);
      }

      // File on disk should contain instrumented code
      expect(instrumentedCode).not.toBe(originalCode);
      expect(instrumentedCode.length).toBeGreaterThan(originalCode.length);
    });
  });

  describe('journal-graph.js — previously failed with oscillation on LangGraph state machine', () => {
    it('produces instrumentation (success or partial) where run-3 produced zero', { timeout: 600_000 }, async () => {
      const { filePath, originalCode } = setupTempFile('src/generators/journal-graph.js');
      const config = makeConfig();

      const result: FileResult = await instrumentWithRetry(
        filePath, originalCode, resolvedSchema, config,
      );

      // Capture the instrumented code before temp cleanup
      const instrumentedCode = readFileSync(filePath, 'utf-8');

      // Build and save diagnostic report + instrumented file
      const report = buildDiagnosticReport('journal-graph.js', result, originalCode, instrumentedCode);
      saveArtifacts('journal-graph.js', report, instrumentedCode);

      // Print full report to test output
      console.log('\n' + report);

      // --- Assertions ---

      // Common invariants
      expect(result.path).toBe(filePath);
      expect(result.tokenUsage).toBeDefined();
      expect(result.validationAttempts).toBeGreaterThanOrEqual(1);
      expect(result.validationStrategyUsed).toBeDefined();
      expect(result.agentVersion).toBeDefined();

      // Must produce instrumentation
      expect(['success', 'partial']).toContain(result.status);
      expect(result.spansAdded).toBeGreaterThan(0);

      // Token usage must reflect real API calls
      const totalTokens = result.tokenUsage.inputTokens + result.tokenUsage.cacheReadInputTokens;
      expect(totalTokens).toBeGreaterThan(0);

      if (result.status === 'partial') {
        expect(result.functionsInstrumented).toBeGreaterThan(0);
        expect(result.functionResults).toBeDefined();
        expect(result.notes!.some(n => n.includes('Function-level fallback'))).toBe(true);
        // journal-graph.js LangGraph node functions should get individual spans
        const succeeded = result.functionResults!.filter(f => f.success);
        expect(succeeded.some(f => f.spansAdded > 0)).toBe(true);
      }

      // File on disk should contain instrumented code
      expect(instrumentedCode).not.toBe(originalCode);
      expect(instrumentedCode.length).toBeGreaterThan(originalCode.length);
    });
  });

  describe('token budget respected across whole-file + function-level attempts', () => {
    it('cumulative tokens stay within maxTokensPerFile for journal-manager.js', { timeout: 600_000 }, async () => {
      const { filePath, originalCode } = setupTempFile('src/managers/journal-manager.js');
      const config = makeConfig();

      const result: FileResult = await instrumentWithRetry(
        filePath, originalCode, resolvedSchema, config,
      );

      // Token budget: cumulative should not exceed config limit
      const totalUsed = result.tokenUsage.inputTokens
        + result.tokenUsage.outputTokens
        + result.tokenUsage.cacheCreationInputTokens
        + result.tokenUsage.cacheReadInputTokens;

      console.log(`\nToken budget check: ${totalUsed.toLocaleString()} / ${config.maxTokensPerFile.toLocaleString()} (${((totalUsed / config.maxTokensPerFile) * 100).toFixed(1)}%)`);

      expect(totalUsed).toBeGreaterThan(0);
      expect(totalUsed).toBeLessThanOrEqual(config.maxTokensPerFile);
    });
  });
});

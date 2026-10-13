// ABOUTME: Tests that the whole-file retry path formats agent output with the project's Prettier config
// ABOUTME: before writing it, so lines pushed past the print width by span wrapping pass LINT and NDS-003.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as prettier from 'prettier';
import { instrumentWithRetry } from '../../src/fix-loop/instrument-with-retry.ts';
import type { InstrumentWithRetryDeps } from '../../src/fix-loop/instrument-with-retry.ts';
import { JavaScriptProvider } from '../../src/languages/javascript/index.ts';
import { nds003Rule } from '../../src/languages/javascript/rules/nds003.ts';
import type { InstrumentationOutput } from '../../src/agent/schema.ts';
import type { InstrumentFileResult } from '../../src/agent/instrument-file.ts';
import type { AgentConfig } from '../../src/config/schema.ts';
import type { CheckResult, ValidateFileInput, ValidationResult } from '../../src/validation/types.ts';

const jsProvider = new JavaScriptProvider();

function makeConfig(): AgentConfig {
  return {
    schemaPath: '/tmp/schema.yaml',
    sdkInitFile: '/tmp/sdk-init.ts',
    agentModel: 'claude-sonnet-4-6',
    agentEffort: 'medium',
    testCommand: 'npm test',
    dependencyStrategy: 'dependencies',
    targetType: 'long-lived',
    language: 'javascript',
    maxFilesPerRun: 50,
    maxFixAttempts: 0,
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
  };
}

function makeOutput(instrumentedCode: string): InstrumentationOutput {
  return {
    instrumentedCode,
    librariesNeeded: [],
    schemaExtensions: [],
    attributesCreated: 0,
    spanCategories: { externalCalls: 0, schemaDefined: 0, serviceEntryPoints: 1, totalFunctionsInFile: 1 },
    suggestedRefactors: [],
    notes: [],
    tokenUsage: { inputTokens: 100, outputTokens: 100, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
  };
}

/** Wrap a single-statement async function body in the agent's standard span shape. */
function wrapInSpan(header: string, bodyLines: string[], spanName: string): string[] {
  return [
    header,
    `  return tracer.startActiveSpan('${spanName}', async (span) => {`,
    '    try {',
    ...bodyLines.map(l => `    ${l}`),
    '    } catch (error) {',
    '      span.recordException(error);',
    '      span.setStatus({ code: SpanStatusCode.ERROR });',
    '      throw error;',
    '    } finally {',
    '      span.end();',
    '    }',
    '  });',
    '}',
  ];
}

const OTEL_PREAMBLE = [
  "import { trace, SpanStatusCode } from '@opentelemetry/api';",
  '',
  "const tracer = trace.getTracer('my-service');",
  '',
];

interface RunOutcome {
  lint: CheckResult;
  nds003: CheckResult[];
  written: string;
}

/**
 * Run one whole-file attempt with the real LINT and NDS-003 checks. Captures what
 * the validators saw and what was on disk when they ran.
 */
async function runOneAttempt(filePath: string, originalCode: string, agentOutput: string): Promise<RunOutcome> {
  let captured: RunOutcome | undefined;
  const deps: InstrumentWithRetryDeps = {
    instrumentFile: async () => ({ success: true, output: makeOutput(agentOutput) }) as InstrumentFileResult,
    validateFile: async (input: ValidateFileInput): Promise<ValidationResult> => {
      const lint = await input.provider.lintCheck(input.originalCode, input.instrumentedCode);
      const nds003 = (await nds003Rule.check({ ...input, language: 'javascript' })) as CheckResult[];
      captured ??= { lint, nds003, written: readFileSync(filePath, 'utf-8') };
      const blockingFailures = [lint, ...nds003].filter(r => !r.passed);
      return {
        passed: blockingFailures.length === 0,
        tier1Results: [lint],
        tier2Results: nds003,
        blockingFailures,
        advisoryFindings: [],
      };
    },
  };
  await instrumentWithRetry(filePath, originalCode, {}, makeConfig(), { deps, provider: jsProvider });
  if (!captured) throw new Error('validateFile was never called');
  return captured;
}

describe('whole-file path formats agent output before validation', () => {
  let testDir: string;
  let previousCwd: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'spiny-orb-whole-file-prettier-'));
    // LINT resolves the Prettier config from the working directory, so the
    // fixture's .prettierrc must be in the directory the process runs from.
    previousCwd = process.cwd();
    process.chdir(testDir);
  });

  afterEach(() => {
    process.chdir(previousCwd);
    rmSync(testDir, { recursive: true, force: true });
  });

  it('passes LINT and NDS-003 when a line exactly at the print width goes over it once wrapped', async () => {
    writeFileSync(join(testDir, '.prettierrc'), JSON.stringify({ singleQuote: true }), 'utf-8');
    const callLine = 'return store.fetchWidgetRecord(widgetId, { includeArchived: true, depth: 3 });';
    const header = 'export async function loadWidget(store, widgetId) {';
    const originalCode = [header, `  ${callLine}`, '}', ''].join('\n');
    expect(`  ${callLine}`).toHaveLength(80);

    // The agent keeps the call on one line, now 84 characters inside the span callback.
    const agentOutput = [...OTEL_PREAMBLE, ...wrapInSpan(header, [`  ${callLine}`], 'widget.load'), ''].join('\n');
    const filePath = join(testDir, 'widget-store.js');
    writeFileSync(filePath, originalCode, 'utf-8');

    const outcome = await runOneAttempt(filePath, originalCode, agentOutput);

    expect(outcome.lint.passed).toBe(true);
    expect(outcome.nds003.filter(r => !r.passed)).toEqual([]);
    expect(await prettier.check(outcome.written, { singleQuote: true, filepath: filePath })).toBe(true);
  });

  it('passes LINT and NDS-003 when a 117-character call becomes 121 characters once wrapped', async () => {
    writeFileSync(join(testDir, '.prettierrc'), JSON.stringify({ singleQuote: true, printWidth: 120 }), 'utf-8');
    const warnLine =
      'logger.warn(`Ledger ${ledger.name} synced with ${ledger.entries.length} entries; review the audit trail soon ok.`);';
    const header = 'export async function syncLedger(client, ledger) {';
    const body = ["await client.post('/ledgers/sync', ledger.entries);", warnLine, 'return ledger.entries.length;'];
    const originalCode = [header, ...body.map(l => `  ${l}`), '}', ''].join('\n');
    expect(`  ${warnLine}`).toHaveLength(117);

    // The span wrapper adds four spaces, so the warn line reaches 121 characters.
    const agentOutput = [
      ...OTEL_PREAMBLE,
      header,
      "  return tracer.startActiveSpan('ledger.sync', async (span) => {",
      '    try {',
      ...body.map(l => `      ${l}`),
      '    } finally {',
      '      span.end();',
      '    }',
      '  });',
      '}',
      '',
    ].join('\n');
    const filePath = join(testDir, 'ledger-sync.js');
    writeFileSync(filePath, originalCode, 'utf-8');

    const outcome = await runOneAttempt(filePath, originalCode, agentOutput);

    expect(outcome.lint.passed).toBe(true);
    expect(outcome.nds003.filter(r => !r.passed)).toEqual([]);
    expect(await prettier.check(outcome.written, { singleQuote: true, printWidth: 120, filepath: filePath })).toBe(true);
  });

  it('formats the advisory-pass output before revalidating it', async () => {
    writeFileSync(join(testDir, '.prettierrc'), JSON.stringify({ singleQuote: true }), 'utf-8');
    const callLine = 'return store.fetchWidgetRecord(widgetId, { includeArchived: true, depth: 3 });';
    const header = 'export async function loadWidget(store, widgetId) {';
    const originalCode = [header, `  ${callLine}`, '}', ''].join('\n');
    const unformatted = [...OTEL_PREAMBLE, ...wrapInSpan(header, [`  ${callLine}`], 'widget.load'), ''].join('\n');
    const filePath = join(testDir, 'widget-store.js');
    writeFileSync(filePath, originalCode, 'utf-8');

    let instrumentCalls = 0;
    let validateCalls = 0;
    let advisoryLint: CheckResult | undefined;
    const advisoryFinding: CheckResult = {
      ruleId: 'CDQ-006', passed: false, filePath, lineNumber: 7, message: 'CDQ-006: advisory', tier: 2, blocking: false,
    };
    const deps: InstrumentWithRetryDeps = {
      // Both the first attempt and the advisory pass return the long, unformatted line.
      instrumentFile: async () => {
        instrumentCalls++;
        return { success: true, output: makeOutput(unformatted) } as InstrumentFileResult;
      },
      validateFile: async (input: ValidateFileInput): Promise<ValidationResult> => {
        validateCalls++;
        const lint = await input.provider.lintCheck(input.originalCode, input.instrumentedCode);
        if (validateCalls === 2) advisoryLint = lint;
        const blockingFailures = lint.passed ? [] : [lint];
        return {
          passed: blockingFailures.length === 0,
          tier1Results: [lint],
          tier2Results: validateCalls === 1 ? [advisoryFinding] : [],
          blockingFailures,
          advisoryFindings: validateCalls === 1 ? [advisoryFinding] : [],
        };
      },
    };
    await instrumentWithRetry(filePath, originalCode, {}, makeConfig(), { deps, provider: jsProvider });

    expect(instrumentCalls).toBe(2);
    expect(advisoryLint?.passed).toBe(true);
  });

  it('leaves the agent output unformatted when the original file is not Prettier-compliant', async () => {
    writeFileSync(join(testDir, '.prettierrc'), JSON.stringify({ singleQuote: true }), 'utf-8');
    // The double-quoted string and the unspaced object literal are not Prettier-compliant.
    const untouchedLine = 'const DEFAULTS = {retries:2, label:"widgets"};';
    const callLine = 'return store.fetchWidgetRecord(widgetId, { includeArchived: true, depth: 3 });';
    const header = 'export async function loadWidget(store, widgetId) {';
    const originalCode = [untouchedLine, '', header, `  ${callLine}`, '}', ''].join('\n');
    const agentOutput = [
      ...OTEL_PREAMBLE,
      untouchedLine,
      '',
      ...wrapInSpan(header, [`  ${callLine}`], 'widget.load'),
      '',
    ].join('\n');
    const filePath = join(testDir, 'widget-store.js');
    writeFileSync(filePath, originalCode, 'utf-8');

    const outcome = await runOneAttempt(filePath, originalCode, agentOutput);

    expect(outcome.written).toBe(agentOutput);
    expect(outcome.written).toContain(untouchedLine);
    expect(outcome.lint.passed).toBe(true);
  });
});

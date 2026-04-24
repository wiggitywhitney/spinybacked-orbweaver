// ABOUTME: Unit tests for PR summary rendering module.
// ABOUTME: Verifies all required PR description sections from a known RunResult.

import { describe, it, expect } from 'vitest';
import { renderPrSummary } from '../../src/deliverables/pr-summary.ts';
import type { RunResult } from '../../src/coordinator/types.ts';
import type { FileResult } from '../../src/fix-loop/types.ts';
import type { TokenUsage } from '../../src/agent/schema.ts';
import type { AgentConfig } from '../../src/config/schema.ts';

/** Helper factory for TokenUsage with overridable defaults. */
function _makeTokenUsage(overrides: Partial<TokenUsage> = {}): TokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    ...overrides,
  };
}

/** Helper factory for FileResult with overridable defaults. */
function _makeFileResult(overrides: Partial<FileResult> = {}): FileResult {
  return {
    path: '/project/src/example.js',
    status: 'success',
    spansAdded: 3,
    librariesNeeded: [],
    schemaExtensions: [],
    attributesCreated: 2,
    validationAttempts: 1,
    validationStrategyUsed: 'initial-generation',
    tokenUsage: _makeTokenUsage({ inputTokens: 5000, outputTokens: 1000 }),
    ...overrides,
  };
}

/** Helper factory for RunResult with overridable defaults. */
function _makeRunResult(overrides: Partial<RunResult> = {}): RunResult {
  return {
    fileResults: [
      _makeFileResult({ path: '/project/src/api-client.js', spansAdded: 4 }),
      _makeFileResult({ path: '/project/src/db-handler.js', spansAdded: 2 }),
    ],
    costCeiling: {
      fileCount: 2,
      totalFileSizeBytes: 10_000,
      maxTokensCeiling: 50_000,
    },
    actualTokenUsage: _makeTokenUsage({ inputTokens: 10_000, outputTokens: 2_000 }),
    filesProcessed: 2,
    filesSucceeded: 2,
    filesFailed: 0,
    filesSkipped: 0,
    filesPartial: 0,
    librariesInstalled: [],
    libraryInstallFailures: [],
    sdkInitUpdated: true,
    runLevelAdvisory: [],
    warnings: [],
    ...overrides,
  };
}

/** Minimal AgentConfig for rendering. */
function _makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    schemaPath: './telemetry/registry',
    sdkInitFile: './src/telemetry/setup.js',
    agentModel: 'claude-sonnet-4-6',
    agentEffort: 'medium',
    autoApproveLibraries: true,
    testCommand: 'npm test',
    dependencyStrategy: 'dependencies',
    targetType: 'long-lived',
    language: 'javascript',
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

describe('renderPrSummary', () => {
  describe('per-file status section', () => {
    it('includes per-file status with spans added for successful files', () => {
      const result = _makeRunResult();
      const md = renderPrSummary(result, _makeConfig());

      expect(md).toContain('api-client.js');
      expect(md).toContain('db-handler.js');
      expect(md).toMatch(/success/i);
    });

    it('includes failure reason for failed files', () => {
      const result = _makeRunResult({
        fileResults: [
          _makeFileResult({
            path: '/project/src/broken.js',
            status: 'failed',
            spansAdded: 0,
            reason: 'Syntax errors persisted after 3 attempts',
          }),
        ],
        filesSucceeded: 0,
        filesFailed: 1,
      });
      const md = renderPrSummary(result, _makeConfig());

      expect(md).toContain('broken.js');
      expect(md).toMatch(/failed/i);
      expect(md).toContain('Syntax errors persisted after 3 attempts');
      // Reason must not use broken \> markdown syntax in table cells
      expect(md).not.toContain('\\>');
    });

    it('renders failure reason inline in the status cell', () => {
      const result = _makeRunResult({
        fileResults: [
          _makeFileResult({
            path: '/project/src/broken.js',
            status: 'failed',
            spansAdded: 0,
            reason: 'Lint errors after retries',
          }),
        ],
        filesSucceeded: 0,
        filesFailed: 1,
      });
      const md = renderPrSummary(result, _makeConfig());

      // The reason should appear in the same row as the file, in the status cell
      const tableLines = md.split('\n').filter(l => l.includes('broken.js'));
      expect(tableLines).toHaveLength(1);
      expect(tableLines[0]).toContain('failed');
      expect(tableLines[0]).toContain('Lint errors after retries');
    });

    it('includes skipped files', () => {
      const result = _makeRunResult({
        fileResults: [
          _makeFileResult({
            path: '/project/src/already-done.js',
            status: 'skipped',
            spansAdded: 0,
          }),
        ],
        filesSkipped: 1,
        filesSucceeded: 0,
      });
      const md = renderPrSummary(result, _makeConfig());

      expect(md).toContain('already-done.js');
      expect(md).toMatch(/skipped/i);
    });

    it('renders partial status with function-level detail', () => {
      const result = _makeRunResult({
        fileResults: [
          _makeFileResult({
            path: '/project/src/complex.js',
            status: 'partial',
            spansAdded: 4,
            functionsInstrumented: 3,
            functionsSkipped: 2,
          }),
        ],
        filesSucceeded: 0,
        filesPartial: 1,
      });
      const md = renderPrSummary(result, _makeConfig());

      expect(md).toContain('complex.js');
      expect(md).toMatch(/partial/i);
      // Should show function counts in the partial status cell
      expect(md).toMatch(/3\/5 functions/);
    });

    it('shows libraries needed per file', () => {
      const result = _makeRunResult({
        fileResults: [
          _makeFileResult({
            librariesNeeded: [
              { package: '@opentelemetry/instrumentation-pg', importName: 'PgInstrumentation' },
            ],
          }),
        ],
      });
      const md = renderPrSummary(result, _makeConfig());

      expect(md).toContain('@opentelemetry/instrumentation-pg');
    });

    it('shows schema extensions per file', () => {
      const result = _makeRunResult({
        fileResults: [
          _makeFileResult({
            schemaExtensions: ['myapp.api_client.fetch_data'],
          }),
        ],
      });
      const md = renderPrSummary(result, _makeConfig());

      expect(md).toContain('myapp.api_client.fetch_data');
    });

    it('shows retry attempt count per file in the table', () => {
      const result = _makeRunResult({
        fileResults: [
          _makeFileResult({ spansAdded: 1, validationAttempts: 5 }),
        ],
      });
      const md = renderPrSummary(result, _makeConfig());

      const tableRow = md.split('\n').find(l => l.includes('example.js'));
      expect(tableRow).toBeDefined();
      expect(tableRow).toContain('5');
    });

    it('shows per-file cost in the table', () => {
      const result = _makeRunResult({
        fileResults: [
          _makeFileResult({
            tokenUsage: _makeTokenUsage({ inputTokens: 10_000, outputTokens: 2_000 }),
          }),
        ],
      });
      const md = renderPrSummary(result, _makeConfig());

      const tableRow = md.split('\n').find(l => l.includes('example.js'));
      expect(tableRow).toBeDefined();
      // Table row should contain a dollar amount for per-file cost
      expect(tableRow).toMatch(/\$[\d.]+/);
    });
  });

  describe('span category breakdown section', () => {
    it('includes span category table with per-file breakdown', () => {
      const result = _makeRunResult({
        fileResults: [
          _makeFileResult({
            path: '/project/src/api-client.js',
            spanCategories: {
              externalCalls: 3,
              schemaDefined: 1,
              serviceEntryPoints: 0,
              totalFunctionsInFile: 10,
            },
          }),
          _makeFileResult({
            path: '/project/src/db-handler.js',
            spanCategories: {
              externalCalls: 2,
              schemaDefined: 0,
              serviceEntryPoints: 1,
              totalFunctionsInFile: 8,
            },
          }),
        ],
      });
      const md = renderPrSummary(result, _makeConfig());

      // Should have a table with category columns
      expect(md).toMatch(/external/i);
      expect(md).toMatch(/schema.defined/i);
      expect(md).toMatch(/service.entry/i);
    });

    it('is always included regardless of reviewSensitivity', () => {
      const result = _makeRunResult({
        fileResults: [
          _makeFileResult({
            spanCategories: {
              externalCalls: 1,
              schemaDefined: 0,
              serviceEntryPoints: 0,
              totalFunctionsInFile: 5,
            },
          }),
        ],
      });

      for (const sensitivity of ['strict', 'moderate', 'off'] as const) {
        const md = renderPrSummary(result, _makeConfig({ reviewSensitivity: sensitivity }));
        expect(md, `breakdown present with ${sensitivity}`).toMatch(/external/i);
      }
    });

    it('skips table when no files have span categories', () => {
      const result = _makeRunResult({
        fileResults: [
          _makeFileResult({ spanCategories: null }),
          _makeFileResult({ spanCategories: undefined }),
        ],
      });
      const md = renderPrSummary(result, _makeConfig());

      // Should not crash, no table rendered
      expect(md).not.toMatch(/external calls/i);
    });
  });

  describe('schema changes section', () => {
    it('includes schema diff when present', () => {
      const result = _makeRunResult({
        schemaDiff: '### Added Spans\n- `myapp.api_client.fetch_data`\n\n### Added Attributes\n- `http.method`',
      });
      const md = renderPrSummary(result, _makeConfig());

      expect(md).toContain('myapp.api_client.fetch_data');
      expect(md).toContain('http.method');
    });

    it('shows "no schema changes" message when diff is absent', () => {
      const result = _makeRunResult({ schemaDiff: undefined });
      const md = renderPrSummary(result, _makeConfig());

      expect(md).toMatch(/no schema changes/i);
    });

    it('lists span extensions from committed files', () => {
      const result = _makeRunResult({
        schemaDiff: '### Added Attributes\n- `http.method`',
        fileResults: [
          _makeFileResult({
            schemaExtensions: [
              'id: span.myapp.fetch_data\ntype: span',
              'id: span.myapp.process_order\ntype: span',
              'id: myapp.request.method\ntype: string',
            ],
          }),
        ],
      });
      const md = renderPrSummary(result, _makeConfig());

      expect(md).toContain('New Span IDs');
      expect(md).toContain('span.myapp.fetch_data');
      expect(md).toContain('span.myapp.process_order');
    });

    it('does not show span extensions section when no spans are present', () => {
      const result = _makeRunResult({
        schemaDiff: '### Added Attributes\n- `http.method`',
        fileResults: [
          _makeFileResult({
            schemaExtensions: ['id: myapp.request.method\ntype: string'],
          }),
        ],
      });
      const md = renderPrSummary(result, _makeConfig());

      expect(md).not.toContain('New Span IDs');
    });

    it('deduplicates span extensions across multiple files', () => {
      const result = _makeRunResult({
        schemaDiff: '### Added',
        fileResults: [
          _makeFileResult({
            path: '/project/src/a.js',
            schemaExtensions: ['id: span.myapp.fetch_data\ntype: span'],
          }),
          _makeFileResult({
            path: '/project/src/b.js',
            schemaExtensions: ['id: span.myapp.fetch_data\ntype: span', 'id: span.myapp.save\ntype: span'],
          }),
        ],
      });
      const md = renderPrSummary(result, _makeConfig());

      // fetch_data appears in both files but should render once
      const matches = md.match(/span\.myapp\.fetch_data/g);
      // One in per-file table extensions column + one in New Span IDs list
      const spanSection = md.split('### New Span IDs')[1]?.split('##')[0] ?? '';
      expect(spanSection.match(/span\.myapp\.fetch_data/g)).toHaveLength(1);
      expect(spanSection).toContain('span.myapp.save');
    });

    it('includes span extensions from partial-status files', () => {
      const result = _makeRunResult({
        schemaDiff: '### Added',
        fileResults: [
          _makeFileResult({
            status: 'partial',
            schemaExtensions: ['id: span.myapp.partial_span\ntype: span'],
          }),
        ],
      });
      const md = renderPrSummary(result, _makeConfig());

      expect(md).toContain('New Span IDs');
      expect(md).toContain('span.myapp.partial_span');
    });

    it('identifies spans by type field when id lacks span. prefix', () => {
      const result = _makeRunResult({
        schemaDiff: '### Added',
        fileResults: [
          _makeFileResult({
            schemaExtensions: ['id: myapp.custom_operation\ntype: span'],
          }),
        ],
      });
      const md = renderPrSummary(result, _makeConfig());

      expect(md).toContain('New Span IDs');
      expect(md).toContain('myapp.custom_operation');
    });

    it('lists bare string span extensions (produced by supplementSchemaExtensions)', () => {
      const result = _makeRunResult({
        schemaDiff: '### Added',
        fileResults: [
          _makeFileResult({
            schemaExtensions: [
              'span.myapp.cli.main',
              'span.myapp.context.gather',
              'myapp.request.method',
            ],
          }),
        ],
      });
      const md = renderPrSummary(result, _makeConfig());

      expect(md).toContain('New Span IDs');
      expect(md).toContain('span.myapp.cli.main');
      expect(md).toContain('span.myapp.context.gather');
      // Non-span bare string should not appear in the New Span IDs section
      const spanSection = md.split('### New Span IDs')[1]?.split('##')[0] ?? '';
      expect(spanSection).not.toContain('myapp.request.method');
    });
  });

  describe('review sensitivity annotations', () => {
    it('flags tier 3+ spans in strict mode', () => {
      const result = _makeRunResult({
        fileResults: [
          _makeFileResult({
            path: '/project/src/handler.js',
            spanCategories: {
              externalCalls: 1,
              schemaDefined: 0,
              serviceEntryPoints: 2,
              totalFunctionsInFile: 8,
            },
          }),
        ],
      });
      const md = renderPrSummary(result, _makeConfig({ reviewSensitivity: 'strict' }));

      // Strict mode flags service entry points (tier 3)
      expect(md).toMatch(/service.entry/i);
      expect(md).toMatch(/review|flag|warning|attention/i);
    });

    it('flags outliers in moderate mode', () => {
      const result = _makeRunResult({
        fileResults: [
          _makeFileResult({
            path: '/project/src/normal.js',
            spansAdded: 2,
            spanCategories: {
              externalCalls: 2,
              schemaDefined: 0,
              serviceEntryPoints: 0,
              totalFunctionsInFile: 10,
            },
          }),
          _makeFileResult({
            path: '/project/src/normal2.js',
            spansAdded: 2,
            spanCategories: {
              externalCalls: 2,
              schemaDefined: 0,
              serviceEntryPoints: 0,
              totalFunctionsInFile: 8,
            },
          }),
          _makeFileResult({
            path: '/project/src/outlier.js',
            spansAdded: 15,
            spanCategories: {
              externalCalls: 5,
              schemaDefined: 3,
              serviceEntryPoints: 7,
              totalFunctionsInFile: 20,
            },
          }),
        ],
      });
      const md = renderPrSummary(result, _makeConfig({ reviewSensitivity: 'moderate' }));

      // Moderate mode flags outlier.js (15 spans vs average ~6)
      expect(md).toContain('outlier.js');
    });

    it('emits no warnings in off mode', () => {
      const result = _makeRunResult({
        fileResults: [
          _makeFileResult({
            spanCategories: {
              externalCalls: 1,
              schemaDefined: 0,
              serviceEntryPoints: 5,
              totalFunctionsInFile: 8,
            },
          }),
        ],
      });
      const md = renderPrSummary(result, _makeConfig({ reviewSensitivity: 'off' }));

      expect(md).not.toMatch(/warning|flag|attention/i);
    });

    it('includes advisory annotations from tier 2 checks', () => {
      const result = _makeRunResult({
        fileResults: [
          _makeFileResult({
            advisoryAnnotations: [
              {
                ruleId: 'CDQ-001',
                passed: false,
                filePath: '/project/src/api-client.js',
                lineNumber: 42,
                message: 'Span name uses camelCase instead of dot.separated',
                tier: 2,
                blocking: false,
              },
            ],
          }),
        ],
      });
      const md = renderPrSummary(result, _makeConfig());

      expect(md).toContain('CDQ-001');
      expect(md).toContain('camelCase');
    });

    it('formats advisory rule IDs with human-readable labels', () => {
      const result = _makeRunResult({
        fileResults: [
          _makeFileResult({
            advisoryAnnotations: [
              {
                ruleId: 'CDQ-001',
                passed: false,
                filePath: '/project/src/api-client.js',
                lineNumber: 42,
                message: 'Span name uses camelCase',
                tier: 2,
                blocking: false,
              },
            ],
          }),
        ],
      });
      const md = renderPrSummary(result, _makeConfig());

      // Rule ID should include human-readable label
      expect(md).toContain('CDQ-001 (Spans Closed)');
    });

    it('suppresses COV-004 advisories for functions deliberately skipped in notes', () => {
      const result = _makeRunResult({
        fileResults: [
          _makeFileResult({
            notes: ['Skipping doFetch (RST-001: pure synchronous function, no I/O)'],
            advisoryAnnotations: [
              {
                ruleId: 'COV-004',
                passed: false,
                filePath: '/project/src/api.js',
                lineNumber: 10,
                message: '"doFetch" (async function) at line 10 has no span. Async functions benefit from spans.',
                tier: 2,
                blocking: false,
              },
            ],
          }),
        ],
      });
      const md = renderPrSummary(result, _makeConfig());

      // COV-004 for a function explicitly skipped by the agent should be suppressed
      // Note: 'doFetch' still appears in Agent Notes — assert on the advisory finding's absence
      expect(md).not.toContain('COV-004');
      expect(md).not.toContain('"doFetch" (async function)');
    });

    it('keeps COV-004 advisories for functions not mentioned in skip notes', () => {
      const result = _makeRunResult({
        fileResults: [
          _makeFileResult({
            notes: ['Added spans to all async entry points'],
            advisoryAnnotations: [
              {
                ruleId: 'COV-004',
                passed: false,
                filePath: '/project/src/api.js',
                lineNumber: 20,
                message: '"handleRequest" (async function) at line 20 has no span. Async functions benefit from spans.',
                tier: 2,
                blocking: false,
              },
            ],
          }),
        ],
      });
      const md = renderPrSummary(result, _makeConfig());

      // COV-004 for a function NOT mentioned as skipped should still appear
      expect(md).toContain('COV-004');
      expect(md).toContain('handleRequest');
    });

    it('does not suppress COV-004 for "process" when notes only mention "processOrder" (word boundary)', () => {
      const result = _makeRunResult({
        fileResults: [
          _makeFileResult({
            notes: ['Skipping processOrder (RST-001: trivial wrapper)'],
            advisoryAnnotations: [
              {
                ruleId: 'COV-004',
                passed: false,
                filePath: '/project/src/api.js',
                lineNumber: 5,
                message: '"process" (async function) at line 5 has no span.',
                tier: 2,
                blocking: false,
              },
            ],
          }),
        ],
      });
      const md = renderPrSummary(result, _makeConfig());

      // "process" is a different function from "processOrder" — advisory must not be suppressed
      expect(md).toContain('COV-004');
    });

    it('keeps COV-004 when notes mention the function but not as a skip', () => {
      const result = _makeRunResult({
        fileResults: [
          _makeFileResult({
            notes: ['Added span to processOrder, instrumented doFetch with trace context'],
            advisoryAnnotations: [
              {
                ruleId: 'COV-004',
                passed: false,
                filePath: '/project/src/api.js',
                lineNumber: 10,
                message: '"doFetch" (async function) at line 10 has no span.',
                tier: 2,
                blocking: false,
              },
            ],
          }),
        ],
      });
      const md = renderPrSummary(result, _makeConfig());

      // Notes mention doFetch but not as a skip — advisory should still appear
      expect(md).toContain('COV-004');
      expect(md).toContain('doFetch');
    });
  });

    it('groups advisories by file — each file gets its own section with a blank line between files', () => {
      const makeAdvisory = (file: string) => ({
        ruleId: 'CDQ-006',
        passed: false,
        filePath: `/project/src/${file}`,
        lineNumber: null,
        message: 'setAttribute with computed value lacks isRecording() guard',
        tier: 2 as const,
        blocking: false,
      });
      const result = _makeRunResult({
        fileResults: [
          _makeFileResult({ path: '/project/src/a.js', advisoryAnnotations: [makeAdvisory('a.js')] }),
          _makeFileResult({ path: '/project/src/b.js', advisoryAnnotations: [makeAdvisory('b.js')] }),
          _makeFileResult({ path: '/project/src/c.js', advisoryAnnotations: [makeAdvisory('c.js')] }),
        ],
      });
      const md = renderPrSummary(result, _makeConfig());

      // Each file gets its own header and finding — 3 separate CDQ-006 bullets
      const advisorySection = md.split('### Advisory Findings')[1]?.split('##')[0] ?? '';
      const cdq006Bullets = advisorySection.split('\n').filter(l => l.startsWith('- ') && l.includes('CDQ-006'));
      expect(cdq006Bullets).toHaveLength(3);
      // All three files appear as bold headers
      expect(advisorySection).toContain('**a.js**');
      expect(advisorySection).toContain('**b.js**');
      expect(advisorySection).toContain('**c.js**');
      // Blank lines separate the file sections
      expect(advisorySection).toContain('\n\n');
    });

  describe('agent notes section', () => {
    it('shows companion file pointer when any file has notes', () => {
      const result = _makeRunResult({
        fileResults: [
          _makeFileResult({
            path: '/project/src/api-client.js',
            notes: ['Added context propagation for outgoing HTTP calls'],
          }),
        ],
      });
      const md = renderPrSummary(result, _makeConfig());

      expect(md).toContain('## Agent Notes');
      expect(md).toContain('.instrumentation.md');
      expect(md).toContain('same directory');
    });

    it('skips notes section when no files have notes', () => {
      const result = _makeRunResult({
        fileResults: [
          _makeFileResult({ notes: undefined }),
          _makeFileResult({ notes: [] }),
        ],
      });
      const md = renderPrSummary(result, _makeConfig());

      expect(md).not.toMatch(/## Agent Notes/i);
    });
  });

  describe('token usage section', () => {
    it('includes ceiling and actuals side by side', () => {
      const result = _makeRunResult({
        costCeiling: {
          fileCount: 5,
          totalFileSizeBytes: 50_000,
          maxTokensCeiling: 100_000,
        },
        actualTokenUsage: _makeTokenUsage({
          inputTokens: 40_000,
          outputTokens: 8_000,
        }),
      });
      const md = renderPrSummary(result, _makeConfig());

      // Should contain both ceiling and actual dollar amounts
      expect(md).toMatch(/ceiling/i);
      expect(md).toMatch(/actual/i);
      expect(md).toContain('$');
    });

    it('shows token counts alongside dollar amounts', () => {
      const result = _makeRunResult({
        actualTokenUsage: _makeTokenUsage({
          inputTokens: 40_000,
          outputTokens: 8_000,
        }),
      });
      const md = renderPrSummary(result, _makeConfig());

      expect(md).toContain('40,000');
      expect(md).toContain('8,000');
    });
  });

  describe('agent version section', () => {
    it('includes agent version when present on file results', () => {
      const result = _makeRunResult({
        fileResults: [
          _makeFileResult({ agentVersion: 'spiny-orb-agent-v0.1.0' }),
        ],
      });
      const md = renderPrSummary(result, _makeConfig());

      expect(md).toContain('spiny-orb-agent-v0.1.0');
    });
  });

  describe('summary header', () => {
    it('includes run summary stats', () => {
      const result = _makeRunResult({
        filesProcessed: 5,
        filesSucceeded: 3,
        filesFailed: 1,
        filesSkipped: 1,
      });
      const md = renderPrSummary(result, _makeConfig());

      expect(md).toContain('5');
      expect(md).toContain('3');
    });

    it('mentions SDK init update', () => {
      const result = _makeRunResult({ sdkInitUpdated: true });
      const md = renderPrSummary(result, _makeConfig());

      expect(md).toMatch(/sdk.init/i);
    });

    it('shows partial count in summary header', () => {
      const result = _makeRunResult({
        filesProcessed: 4,
        filesSucceeded: 1,
        filesFailed: 1,
        filesSkipped: 1,
        filesPartial: 1,
      });
      const md = renderPrSummary(result, _makeConfig());

      expect(md).toMatch(/partial.*1/i);
    });

    it('mentions installed libraries', () => {
      const result = _makeRunResult({
        librariesInstalled: ['@opentelemetry/instrumentation-http'],
      });
      const md = renderPrSummary(result, _makeConfig());

      expect(md).toContain('@opentelemetry/instrumentation-http');
    });
  });

  describe('warnings and errors', () => {
    it('includes run-level warnings', () => {
      const result = _makeRunResult({
        warnings: ['Schema checkpoint failed at file 5 — continuing with cached schema'],
      });
      const md = renderPrSummary(result, _makeConfig());

      expect(md).toContain('Schema checkpoint failed');
    });

    it('includes run-level advisory findings', () => {
      const result = _makeRunResult({
        runLevelAdvisory: [
          {
            ruleId: 'CDQ-008',
            passed: false,
            filePath: '',
            lineNumber: null,
            message: 'Inconsistent tracer names across files',
            tier: 2,
            blocking: false,
          },
        ],
      });
      const md = renderPrSummary(result, _makeConfig());

      expect(md).toContain('CDQ-008 (Tracer Naming)');
      expect(md).toContain('Inconsistent tracer names');
    });
  });

  describe('end-to-end rendering', () => {
    it('renders valid markdown without crashing for a complete RunResult', () => {
      const result = _makeRunResult({
        fileResults: [
          _makeFileResult({
            path: '/project/src/api-client.js',
            spansAdded: 4,
            spanCategories: {
              externalCalls: 3,
              schemaDefined: 1,
              serviceEntryPoints: 0,
              totalFunctionsInFile: 12,
            },
            notes: ['Added HTTP span for fetch calls'],
            librariesNeeded: [
              { package: '@opentelemetry/instrumentation-http', importName: 'HttpInstrumentation' },
            ],
            schemaExtensions: ['myapp.api_client.fetch_data'],
            advisoryAnnotations: [],
            agentVersion: 'spiny-orb-agent-v0.1.0',
          }),
          _makeFileResult({
            path: '/project/src/db-handler.js',
            status: 'failed',
            spansAdded: 0,
            reason: 'Lint errors persisted after 3 attempts',
            agentVersion: 'spiny-orb-agent-v0.1.0',
          }),
        ],
        schemaDiff: '### Added\n- `myapp.api_client.fetch_data`',
        costCeiling: {
          fileCount: 2,
          totalFileSizeBytes: 15_000,
          maxTokensCeiling: 80_000,
        },
        actualTokenUsage: _makeTokenUsage({
          inputTokens: 30_000,
          outputTokens: 5_000,
        }),
        filesProcessed: 2,
        filesSucceeded: 1,
        filesFailed: 1,
        librariesInstalled: ['@opentelemetry/instrumentation-http'],
        sdkInitUpdated: true,
        warnings: ['Large file warning: api-client.js has 600 lines'],
      });
      const md = renderPrSummary(result, _makeConfig());

      // Should be a non-empty string
      expect(md.length).toBeGreaterThan(100);

      // All major sections present
      expect(md).toMatch(/## Summary/i);
      expect(md).toMatch(/## Per-File/i);
      expect(md).toMatch(/## Span Categor/i);
      expect(md).toMatch(/## Schema Changes/i);
      expect(md).toMatch(/## Token Usage/i);
    });
  });

  describe('recommended refactors section', () => {
    it('renders section when files have suggested refactors', () => {
      const result = _makeRunResult({
        fileResults: [
          _makeFileResult({
            path: '/project/src/context-integrator.js',
            status: 'failed',
            spansAdded: 0,
            suggestedRefactors: [
              {
                description: 'Extract complex expression to a const before setAttribute call',
                diff: '- span.setAttribute("result", computeResult(a, b));\n+ const result = computeResult(a, b);\n+ span.setAttribute("result", result);',
                reason: 'setAttribute requires a simple variable reference for safe capture',
                unblocksRules: ['NDS-003'],
                location: { filePath: '/project/src/context-integrator.js', startLine: 42, endLine: 44 },
              },
            ],
          }),
        ],
        filesSucceeded: 0,
        filesFailed: 1,
      });
      const md = renderPrSummary(result, _makeConfig(), '/project');

      expect(md).toContain('## Recommended Refactors');
      expect(md).toContain('context-integrator.js');
      expect(md).toContain('Extract complex expression');
      expect(md).toContain('NDS-003');
      expect(md).toContain('42');
    });

    it('omits diffs from PR summary for redaction', () => {
      const result = _makeRunResult({
        fileResults: [
          _makeFileResult({
            path: '/project/src/context-integrator.js',
            status: 'failed',
            spansAdded: 0,
            suggestedRefactors: [
              {
                description: 'Extract expression to const',
                diff: '- span.setAttribute("result", computeResult(a, b));\n+ const result = computeResult(a, b);',
                reason: 'setAttribute requires simple variable',
                unblocksRules: ['NDS-003'],
                location: { filePath: '/project/src/context-integrator.js', startLine: 42, endLine: 44 },
              },
            ],
          }),
        ],
        filesSucceeded: 0,
        filesFailed: 1,
      });
      const md = renderPrSummary(result, _makeConfig());

      // Diff content must NOT appear in PR summary
      expect(md).not.toContain('computeResult');
      expect(md).not.toContain('span.setAttribute');
    });

    it('skips section when no files have suggested refactors', () => {
      const result = _makeRunResult({
        fileResults: [
          _makeFileResult({ suggestedRefactors: undefined }),
          _makeFileResult({ suggestedRefactors: [] }),
        ],
      });
      const md = renderPrSummary(result, _makeConfig());

      expect(md).not.toContain('Recommended Refactors');
    });

    it('renders multiple refactors across multiple files', () => {
      const result = _makeRunResult({
        fileResults: [
          _makeFileResult({
            path: '/project/src/context-integrator.js',
            status: 'failed',
            spansAdded: 0,
            suggestedRefactors: [
              {
                description: 'Extract expression to const',
                diff: 'diff content 1',
                reason: 'setAttribute needs simple variable',
                unblocksRules: ['NDS-003'],
                location: { filePath: '/project/src/context-integrator.js', startLine: 42, endLine: 44 },
              },
            ],
          }),
          _makeFileResult({
            path: '/project/src/journal-manager.js',
            status: 'failed',
            spansAdded: 0,
            suggestedRefactors: [
              {
                description: 'Split nested callback into named function',
                diff: 'diff content 2',
                reason: 'Nested callbacks prevent span wrapping',
                unblocksRules: ['NDS-003', 'COV-003'],
                location: { filePath: '/project/src/journal-manager.js', startLine: 100, endLine: 120 },
              },
              {
                description: 'Move inline computation to separate function',
                diff: 'diff content 3',
                reason: 'Cannot add span to inline expression',
                unblocksRules: ['NDS-003'],
                location: { filePath: '/project/src/journal-manager.js', startLine: 200, endLine: 210 },
              },
            ],
          }),
        ],
        filesSucceeded: 0,
        filesFailed: 2,
      });
      const md = renderPrSummary(result, _makeConfig(), '/project');

      expect(md).toContain('context-integrator.js');
      expect(md).toContain('journal-manager.js');
      expect(md).toContain('Extract expression to const');
      expect(md).toContain('Split nested callback');
      expect(md).toContain('Move inline computation');
      // Multiple rules shown
      expect(md).toContain('NDS-003');
      expect(md).toContain('COV-003');
    });

    it('formats unblocksRules with human-readable labels', () => {
      const result = _makeRunResult({
        fileResults: [
          _makeFileResult({
            path: '/project/src/file.js',
            status: 'failed',
            spansAdded: 0,
            suggestedRefactors: [
              {
                description: 'Extract expression',
                diff: 'diff',
                reason: 'reason',
                unblocksRules: ['NDS-003'],
                location: { filePath: '/project/src/file.js', startLine: 10, endLine: 12 },
              },
            ],
          }),
        ],
        filesSucceeded: 0,
        filesFailed: 1,
      });
      const md = renderPrSummary(result, _makeConfig());

      expect(md).toContain('NDS-003 (Code Preserved)');
    });

    it('shows reason for each recommendation', () => {
      const result = _makeRunResult({
        fileResults: [
          _makeFileResult({
            path: '/project/src/file.js',
            status: 'failed',
            spansAdded: 0,
            suggestedRefactors: [
              {
                description: 'Extract expression',
                diff: 'diff',
                reason: 'setAttribute requires a simple variable reference',
                unblocksRules: ['NDS-003'],
                location: { filePath: '/project/src/file.js', startLine: 10, endLine: 12 },
              },
            ],
          }),
        ],
        filesSucceeded: 0,
        filesFailed: 1,
      });
      const md = renderPrSummary(result, _makeConfig());

      expect(md).toContain('setAttribute requires a simple variable reference');
    });

    it('shows line range in location', () => {
      const result = _makeRunResult({
        fileResults: [
          _makeFileResult({
            path: '/project/src/file.js',
            status: 'failed',
            spansAdded: 0,
            suggestedRefactors: [
              {
                description: 'Extract expression',
                diff: 'diff',
                reason: 'reason',
                unblocksRules: ['NDS-003'],
                location: { filePath: '/project/src/file.js', startLine: 42, endLine: 48 },
              },
            ],
          }),
        ],
        filesSucceeded: 0,
        filesFailed: 1,
      });
      const md = renderPrSummary(result, _makeConfig());

      expect(md).toMatch(/L42[–-]48/);
    });
  });

  describe('rolled back files section', () => {
    it('renders section when files were rolled back due to test failure', () => {
      const result = _makeRunResult({
        fileResults: [
          _makeFileResult({
            path: '/project/src/good.js',
            status: 'success',
          }),
          _makeFileResult({
            path: '/project/src/regular-failed.js',
            status: 'failed',
            spansAdded: 0,
            reason: 'Syntax errors after retries',
          }),
          _makeFileResult({
            path: '/project/src/rolled-back-a.js',
            status: 'failed',
            spansAdded: 0,
            reason: 'Rolled back: end-of-run test failure',
          }),
          _makeFileResult({
            path: '/project/src/rolled-back-b.js',
            status: 'failed',
            spansAdded: 0,
            reason: 'Rolled back: end-of-run test failure',
          }),
        ],
        filesSucceeded: 1,
        filesFailed: 3,
      });
      const md = renderPrSummary(result, _makeConfig(), '/project');

      expect(md).toContain('## Rolled Back Files');
      expect(md).toContain('rolled-back-a.js');
      expect(md).toContain('rolled-back-b.js');
      expect(md).toContain('end-of-run test failure');
      // The successful file should NOT appear in rolled-back section
      expect(md.split('## Rolled Back Files')[1]).not.toContain('good.js');
      // Regular failed file (not rolled back) should NOT appear in rolled-back section
      expect(md.split('## Rolled Back Files')[1]).not.toContain('regular-failed.js');
    });

    it('includes checkpoint rollback files in the section', () => {
      const result = _makeRunResult({
        fileResults: [
          _makeFileResult({
            path: '/project/src/checkpoint-fail.js',
            status: 'failed',
            spansAdded: 0,
            reason: 'Rolled back: checkpoint test failure at file 5/10',
          }),
        ],
        filesSucceeded: 0,
        filesFailed: 1,
      });
      const md = renderPrSummary(result, _makeConfig(), '/project');

      expect(md).toContain('## Rolled Back Files');
      expect(md).toContain('checkpoint-fail.js');
    });

    it('omits section when no files were rolled back', () => {
      const result = _makeRunResult({
        fileResults: [
          _makeFileResult({ status: 'success' }),
          _makeFileResult({ status: 'failed', reason: 'Syntax errors after retries' }),
        ],
        filesSucceeded: 1,
        filesFailed: 1,
      });
      const md = renderPrSummary(result, _makeConfig());

      expect(md).not.toContain('## Rolled Back Files');
    });
  });

  describe('live-check compliance report', () => {
    it('renders end-of-run validation when present', () => {
      const result = _makeRunResult({
        endOfRunValidation: 'Schema compliance: 5/5 spans matched, 0 violations',
      });
      const md = renderPrSummary(result, _makeConfig());

      expect(md).toContain('## Live-Check Compliance');
      expect(md).toContain('5/5 spans matched');
    });

    it('omits live-check section when endOfRunValidation is absent', () => {
      const result = _makeRunResult();
      const md = renderPrSummary(result, _makeConfig());

      expect(md).not.toContain('Live-Check');
    });
  });

  describe('companion packages section', () => {
    it('renders companion packages section when companionPackages is populated', () => {
      const result = _makeRunResult({
        companionPackages: [
          '@traceloop/instrumentation-langchain',
          '@traceloop/instrumentation-mcp',
        ],
      });
      const md = renderPrSummary(result, _makeConfig());

      expect(md).toContain('## Recommended Companion Packages');
      expect(md).toContain('@traceloop/instrumentation-langchain');
      expect(md).toContain('@traceloop/instrumentation-mcp');
    });

    it('omits companion packages section when companionPackages is absent', () => {
      const result = _makeRunResult();
      const md = renderPrSummary(result, _makeConfig());

      expect(md).not.toContain('Recommended Companion Packages');
    });

    it('omits companion packages section when companionPackages is empty', () => {
      const result = _makeRunResult({ companionPackages: [] });
      const md = renderPrSummary(result, _makeConfig());

      expect(md).not.toContain('Recommended Companion Packages');
    });

    it('includes in-app initialization warning for all targets with companion packages', () => {
      const result = _makeRunResult({
        companionPackages: ['@traceloop/instrumentation-langchain'],
      });
      const md = renderPrSummary(result, _makeConfig({ targetType: 'long-lived' }));

      expect(md).toContain('Recommended Companion Packages');
      expect(md).toContain('--import');
      expect(md).toContain('inside your application code');
    });

    it('includes short-lived section link for short-lived targets with companion packages', () => {
      const result = _makeRunResult({
        companionPackages: ['@traceloop/instrumentation-langchain'],
      });
      const md = renderPrSummary(result, _makeConfig({ targetType: 'short-lived' }));
      const companionSection = md.split('## Recommended Companion Packages')[1]?.split('##')[0] ?? '';

      expect(companionSection).toContain('Short-Lived Process Setup Guidance');
    });
  });

  describe('failed file metadata scrubbing', () => {
    it('does not show schema extensions for failed files in per-file table', () => {
      const failedFile = _makeFileResult({
        path: '/project/src/broken.js',
        status: 'failed',
        spansAdded: 0,
        schemaExtensions: ['span.myapp.rejected.operation', 'myapp.rejected.attribute'],
        librariesNeeded: [{ package: '@traceloop/instrumentation-langchain', importName: 'LangChainInstrumentation' }],
        reason: 'Validation failed',
      });
      const result = _makeRunResult({
        fileResults: [failedFile],
        filesSucceeded: 0,
        filesFailed: 1,
      });

      const md = renderPrSummary(result, _makeConfig());

      // Failed file's rejected extensions and libraries should not appear
      expect(md).not.toContain('myapp.rejected.operation');
      expect(md).not.toContain('myapp.rejected.attribute');
      expect(md).not.toContain('instrumentation-langchain');
    });

    it('shows schema extensions for success files in per-file table', () => {
      const successFile = _makeFileResult({
        path: '/project/src/good.js',
        status: 'success',
        spansAdded: 3,
        schemaExtensions: ['span.myapp.committed.operation'],
        librariesNeeded: [{ package: '@opentelemetry/instrumentation-pg', importName: 'PgInstrumentation' }],
      });
      const result = _makeRunResult({
        fileResults: [successFile],
      });

      const md = renderPrSummary(result, _makeConfig());

      expect(md).toContain('myapp.committed.operation');
      expect(md).toContain('instrumentation-pg');
    });
  });

  describe('zero-span file compression (#242)', () => {
    it('groups zero-span files into a summary line instead of individual rows', () => {
      const files = [
        _makeFileResult({ path: '/project/src/api.js', spansAdded: 3, status: 'success' }),
        _makeFileResult({ path: '/project/src/helper1.js', spansAdded: 0, status: 'success', notes: ['No instrumentable functions'] }),
        _makeFileResult({ path: '/project/src/helper2.js', spansAdded: 0, status: 'success', notes: ['No instrumentable functions'] }),
        _makeFileResult({ path: '/project/src/helper3.js', spansAdded: 0, status: 'success', notes: ['No instrumentable functions'] }),
      ];
      const result = _makeRunResult({ fileResults: files, filesSucceeded: 4 });
      const md = renderPrSummary(result, _makeConfig());

      // The instrumented file should be in the per-file table
      expect(md).toContain('api.js');
      // Zero-span files should be grouped, not individual rows
      const tableRows = md.split('\n').filter(l => l.startsWith('|') && !l.includes('---'));
      const zeroSpanRows = tableRows.filter(r => r.includes('helper1') || r.includes('helper2') || r.includes('helper3'));
      expect(zeroSpanRows.length).toBeLessThanOrEqual(1); // grouped into 0 or 1 rows
    });

    it('does not list notes for zero-span files individually', () => {
      const files = [
        _makeFileResult({ path: '/project/src/api.js', spansAdded: 3, notes: ['Instrumented 3 functions'] }),
        _makeFileResult({ path: '/project/src/skip1.js', spansAdded: 0, notes: ['No instrumentable functions'] }),
        _makeFileResult({ path: '/project/src/skip2.js', spansAdded: 0, notes: ['Sync-only file, no I/O'] }),
      ];
      const result = _makeRunResult({ fileResults: files, filesSucceeded: 3 });
      const md = renderPrSummary(result, _makeConfig());

      // Instrumented file (api.js) has notes — Agent Notes section should appear with companion pointer
      expect(md).toContain('## Agent Notes');
      expect(md).toContain('.instrumentation.md');
    });

    it('distinguishes committed vs correct-skip in summary header', () => {
      const files = [
        _makeFileResult({ path: '/project/src/api.js', spansAdded: 3 }),
        _makeFileResult({ path: '/project/src/skip.js', spansAdded: 0 }),
      ];
      const result = _makeRunResult({ fileResults: files, filesSucceeded: 2 });
      const md = renderPrSummary(result, _makeConfig());

      expect(md).toContain('Committed');
      expect(md).toContain('1');
      expect(md).toContain('No changes needed');
    });
  });

  describe('short-lived setup guidance section', () => {
    it('includes setup guidance section when targetType is short-lived', () => {
      const result = _makeRunResult();
      const md = renderPrSummary(result, _makeConfig({ targetType: 'short-lived' }));

      expect(md).toContain('## Short-Lived Process Setup Guidance');
    });

    it('does not include setup guidance when targetType is long-lived', () => {
      const result = _makeRunResult();
      const md = renderPrSummary(result, _makeConfig({ targetType: 'long-lived' }));

      expect(md).not.toContain('## Short-Lived Process Setup Guidance');
    });

    it('does not include setup guidance when targetType is default (long-lived)', () => {
      const result = _makeRunResult();
      const md = renderPrSummary(result, _makeConfig());

      expect(md).not.toContain('## Short-Lived Process Setup Guidance');
    });

    it('mentions SimpleSpanProcessor for short-lived targets', () => {
      const result = _makeRunResult();
      const md = renderPrSummary(result, _makeConfig({ targetType: 'short-lived' }));

      expect(md).toContain('SimpleSpanProcessor');
    });

    it('mentions process.exit interception for short-lived targets', () => {
      const result = _makeRunResult();
      const md = renderPrSummary(result, _makeConfig({ targetType: 'short-lived' }));

      expect(md).toContain('process.exit');
    });

    it('does not include auto-instrumentation warning — that lives in companion packages section', () => {
      const result = _makeRunResult();
      const md = renderPrSummary(result, _makeConfig({ targetType: 'short-lived' }));

      expect(md).not.toContain('Auto-Instrumentation Warning');
      // Essential setup content still present
      expect(md).toContain('SimpleSpanProcessor');
      expect(md).toContain('process.exit');
    });
  });
});

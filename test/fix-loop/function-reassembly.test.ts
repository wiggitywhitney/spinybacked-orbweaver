// ABOUTME: Tests for function reassembly module (PRD #106 milestone 3).
// ABOUTME: Verifies reassembly of instrumented functions back into the original file with deduplication.

import { describe, it, expect } from 'vitest';
import { reassembleFunctions, deduplicateImports, ensureTracerAfterImports } from '../../src/fix-loop/function-reassembly.ts';
import type { FunctionResult } from '../../src/fix-loop/types.ts';
import type { ExtractedFunction } from '../../src/fix-loop/function-extraction.ts';

/**
 * Helper to build a minimal ExtractedFunction for testing.
 * Only the fields used by reassembly are populated.
 */
function makeExtractedFunction(overrides: Partial<ExtractedFunction> & { name: string; startLine: number; endLine: number; sourceText: string }): ExtractedFunction {
  return {
    isAsync: false,
    isExported: true,
    jsDoc: null,
    referencedConstants: [],
    referencedImports: [],
    buildContext: () => overrides.sourceText,
    ...overrides,
  };
}

/**
 * Helper to build a minimal FunctionResult for testing.
 */
function makeFunctionResult(overrides: Partial<FunctionResult> & { name: string }): FunctionResult {
  return {
    success: true,
    spansAdded: 1,
    librariesNeeded: [],
    schemaExtensions: [],
    attributesCreated: 1,
    tokenUsage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
    ...overrides,
  };
}

describe('reassembleFunctions', () => {
  const originalFile = `import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const MAX_RETRIES = 3;
const DEFAULT_TIMEOUT = 5000;

/**
 * Fetch with retry.
 */
export async function fetchWithRetry(url, options = {}) {
  let lastError;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(url, { ...options });
      if (response.ok) return response;
      lastError = new Error('HTTP error');
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

export async function saveData(filePath, data) {
  const resolved = path.resolve(filePath);
  const content = JSON.stringify(data, null, 2);
  await writeFile(resolved, content, 'utf-8');
}
`;

  it('replaces a single function with its instrumented version', () => {
    const extractedFunctions: ExtractedFunction[] = [
      makeExtractedFunction({
        name: 'fetchWithRetry',
        startLine: 10,
        endLine: 22,
        sourceText: 'export async function fetchWithRetry(url, options = {}) { /* original */ }',
      }),
    ];

    const functionResults: FunctionResult[] = [
      makeFunctionResult({
        name: 'fetchWithRetry',
        instrumentedCode: `import { readFile, writeFile } from 'node:fs/promises';
import { trace } from '@opentelemetry/api';

const MAX_RETRIES = 3;
const DEFAULT_TIMEOUT = 5000;

export async function fetchWithRetry(url, options = {}) {
  return trace.getTracer('my-service').startActiveSpan('fetchWithRetry', async (span) => {
    let lastError;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const response = await fetch(url, { ...options });
        if (response.ok) {
          span.setStatus({ code: 1 });
          return response;
        }
        lastError = new Error('HTTP error');
      } catch (error) {
        span.recordException(error);
        lastError = error;
      }
    }
    span.setStatus({ code: 2, message: 'All retries exhausted' });
    span.end();
    throw lastError;
  });
}`,
      }),
    ];

    const result = reassembleFunctions(originalFile, extractedFunctions, functionResults);

    // Should contain the instrumented function body
    expect(result).toContain('startActiveSpan');
    expect(result).toContain('span.recordException');
    // Should contain OTel import
    expect(result).toContain("import { trace } from '@opentelemetry/api'");
    // Should still contain the original imports
    expect(result).toContain("import { readFile, writeFile } from 'node:fs/promises'");
    expect(result).toContain("import path from 'node:path'");
    // Should still contain saveData (untouched)
    expect(result).toContain('export async function saveData');
    // Should still contain constants
    expect(result).toContain('const MAX_RETRIES = 3');
  });

  it('replaces multiple functions', () => {
    const extractedFunctions: ExtractedFunction[] = [
      makeExtractedFunction({
        name: 'fetchWithRetry',
        startLine: 10,
        endLine: 22,
        sourceText: 'export async function fetchWithRetry(url, options = {}) { /* original */ }',
      }),
      makeExtractedFunction({
        name: 'saveData',
        startLine: 24,
        endLine: 28,
        sourceText: 'export async function saveData(filePath, data) { /* original */ }',
      }),
    ];

    const functionResults: FunctionResult[] = [
      makeFunctionResult({
        name: 'fetchWithRetry',
        instrumentedCode: `import { trace } from '@opentelemetry/api';

export async function fetchWithRetry(url, options = {}) {
  return trace.getTracer('svc').startActiveSpan('fetchWithRetry', async (span) => {
    span.end();
  });
}`,
      }),
      makeFunctionResult({
        name: 'saveData',
        instrumentedCode: `import { trace } from '@opentelemetry/api';

export async function saveData(filePath, data) {
  return trace.getTracer('svc').startActiveSpan('saveData', async (span) => {
    span.end();
  });
}`,
      }),
    ];

    const result = reassembleFunctions(originalFile, extractedFunctions, functionResults);

    // Both functions should be instrumented
    expect(result).toContain("startActiveSpan('fetchWithRetry'");
    expect(result).toContain("startActiveSpan('saveData'");
    // OTel import should appear only once (deduplicated)
    const traceImportCount = (result.match(/import \{ trace \} from '@opentelemetry\/api'/g) || []).length;
    expect(traceImportCount).toBe(1);
  });

  it('skips failed function results (only replaces successful ones)', () => {
    const extractedFunctions: ExtractedFunction[] = [
      makeExtractedFunction({
        name: 'fetchWithRetry',
        startLine: 10,
        endLine: 22,
        sourceText: 'export async function fetchWithRetry(url, options = {}) { /* original */ }',
      }),
      makeExtractedFunction({
        name: 'saveData',
        startLine: 24,
        endLine: 28,
        sourceText: 'export async function saveData(filePath, data) { /* original */ }',
      }),
    ];

    const functionResults: FunctionResult[] = [
      makeFunctionResult({
        name: 'fetchWithRetry',
        success: false,
        error: 'Validation failed after 3 attempts',
      }),
      makeFunctionResult({
        name: 'saveData',
        instrumentedCode: `import { trace } from '@opentelemetry/api';

export async function saveData(filePath, data) {
  return trace.getTracer('svc').startActiveSpan('saveData', async (span) => {
    span.end();
  });
}`,
      }),
    ];

    const result = reassembleFunctions(originalFile, extractedFunctions, functionResults);

    // fetchWithRetry should remain original
    expect(result).toContain('throw lastError');
    expect(result).not.toContain("startActiveSpan('fetchWithRetry'");
    // saveData should be instrumented
    expect(result).toContain("startActiveSpan('saveData'");
  });

  it('returns original file when all function results failed', () => {
    const extractedFunctions: ExtractedFunction[] = [
      makeExtractedFunction({
        name: 'fetchWithRetry',
        startLine: 10,
        endLine: 22,
        sourceText: 'export async function fetchWithRetry(url, options = {}) { /* original */ }',
      }),
    ];

    const functionResults: FunctionResult[] = [
      makeFunctionResult({
        name: 'fetchWithRetry',
        success: false,
        error: 'Validation failed',
      }),
    ];

    const result = reassembleFunctions(originalFile, extractedFunctions, functionResults);

    expect(result).toBe(originalFile);
  });

  it('handles functions with no new imports (only body changes)', () => {
    const simpleFile = `export function processItems(items) {
  const results = [];
  for (const item of items) {
    results.push(item.transform());
  }
  return results;
}
`;

    const extractedFunctions: ExtractedFunction[] = [
      makeExtractedFunction({
        name: 'processItems',
        startLine: 1,
        endLine: 7,
        sourceText: 'export function processItems(items) { /* original */ }',
      }),
    ];

    const functionResults: FunctionResult[] = [
      makeFunctionResult({
        name: 'processItems',
        instrumentedCode: `import { trace } from '@opentelemetry/api';

export function processItems(items) {
  return trace.getTracer('svc').startActiveSpan('processItems', (span) => {
    const results = [];
    for (const item of items) {
      results.push(item.transform());
    }
    span.setAttribute('items.count', results.length);
    span.end();
    return results;
  });
}`,
      }),
    ];

    const result = reassembleFunctions(simpleFile, extractedFunctions, functionResults);

    expect(result).toContain("import { trace } from '@opentelemetry/api'");
    expect(result).toContain('startActiveSpan');
    expect(result).toContain("span.setAttribute('items.count'");
  });

  it('handles arrow function replacement', () => {
    const arrowFile = `const CACHE = new Map();

export const transformData = async (input) => {
  const cached = CACHE.get(input.id);
  if (cached) return cached;
  const result = { id: input.id, processed: true };
  CACHE.set(input.id, result);
  return result;
};
`;

    const extractedFunctions: ExtractedFunction[] = [
      makeExtractedFunction({
        name: 'transformData',
        startLine: 3,
        endLine: 9,
        sourceText: 'export const transformData = async (input) => { /* original */ };',
      }),
    ];

    const functionResults: FunctionResult[] = [
      makeFunctionResult({
        name: 'transformData',
        instrumentedCode: `import { trace } from '@opentelemetry/api';

const CACHE = new Map();

export const transformData = async (input) => {
  return trace.getTracer('svc').startActiveSpan('transformData', async (span) => {
    const cached = CACHE.get(input.id);
    if (cached) return cached;
    const result = { id: input.id, processed: true };
    CACHE.set(input.id, result);
    span.end();
    return result;
  });
};`,
      }),
    ];

    const result = reassembleFunctions(arrowFile, extractedFunctions, functionResults);

    expect(result).toContain("import { trace } from '@opentelemetry/api'");
    expect(result).toContain('startActiveSpan');
    expect(result).toContain('const CACHE = new Map()');
  });
});

describe('deduplicateImports', () => {
  it('merges identical imports from the same module into one', () => {
    const imports = [
      "import { trace } from '@opentelemetry/api';",
      "import { trace } from '@opentelemetry/api';",
      "import { SpanStatusCode } from '@opentelemetry/api';",
    ];
    const result = deduplicateImports(imports);
    // All three are from the same module — should merge into one
    expect(result).toHaveLength(1);
    expect(result[0]).toContain('trace');
    expect(result[0]).toContain('SpanStatusCode');
  });

  it('merges named imports from the same module', () => {
    const imports = [
      "import { trace } from '@opentelemetry/api';",
      "import { SpanStatusCode } from '@opentelemetry/api';",
    ];
    const result = deduplicateImports(imports);
    expect(result).toHaveLength(1);
    expect(result[0]).toContain('trace');
    expect(result[0]).toContain('SpanStatusCode');
    expect(result[0]).toContain('@opentelemetry/api');
  });

  it('keeps imports from different modules separate', () => {
    const imports = [
      "import { trace } from '@opentelemetry/api';",
      "import { NodeSDK } from '@opentelemetry/sdk-node';",
    ];
    const result = deduplicateImports(imports);
    expect(result).toHaveLength(2);
  });

  it('returns empty array for empty input', () => {
    expect(deduplicateImports([])).toEqual([]);
  });

  it('deduplicates named imports within a merge', () => {
    const imports = [
      "import { trace, SpanStatusCode } from '@opentelemetry/api';",
      "import { trace } from '@opentelemetry/api';",
    ];
    const result = deduplicateImports(imports);
    expect(result).toHaveLength(1);
    const traceCount = (result[0].match(/trace/g) || []).length;
    expect(traceCount).toBe(1);
    expect(result[0]).toContain('SpanStatusCode');
  });
});

describe('reassembleFunctions — tracer init detection', () => {
  const fileWithImports = `import { readFile } from 'node:fs/promises';

const CONFIG = { timeout: 5000 };

export async function fetchData(url) {
  const resp = await fetch(url);
  return resp.json();
}

export function processItems(items) {
  return items.map(i => i.value);
}
`;

  it('collects const tracer = trace.getTracer(...) from instrumented code and inserts at module scope', () => {
    const extractedFunctions: ExtractedFunction[] = [
      makeExtractedFunction({
        name: 'fetchData',
        startLine: 5,
        endLine: 8,
        sourceText: 'export async function fetchData(url) { /* original */ }',
      }),
    ];

    const functionResults: FunctionResult[] = [
      makeFunctionResult({
        name: 'fetchData',
        instrumentedCode: `import { trace, SpanStatusCode } from '@opentelemetry/api';

const tracer = trace.getTracer('my-service');

export async function fetchData(url) {
  return tracer.startActiveSpan('fetchData', async (span) => {
    const resp = await fetch(url);
    span.setStatus({ code: SpanStatusCode.OK });
    span.end();
    return resp.json();
  });
}`,
      }),
    ];

    const result = reassembleFunctions(fileWithImports, extractedFunctions, functionResults);

    // Should have the OTel import
    expect(result).toContain("import { SpanStatusCode, trace } from '@opentelemetry/api'");
    // Should have the tracer init at module scope (after imports, before functions)
    expect(result).toContain("const tracer = trace.getTracer('my-service')");
    // Should have the instrumented function referencing tracer
    expect(result).toContain('tracer.startActiveSpan');
    // Tracer init should appear before the function
    const tracerIdx = result.indexOf("const tracer = trace.getTracer('my-service')");
    const fnIdx = result.indexOf('export async function fetchData');
    expect(tracerIdx).toBeLessThan(fnIdx);
  });

  it('deduplicates identical tracer init lines from multiple functions', () => {
    const extractedFunctions: ExtractedFunction[] = [
      makeExtractedFunction({
        name: 'fetchData',
        startLine: 5,
        endLine: 8,
        sourceText: 'export async function fetchData(url) { /* original */ }',
      }),
      makeExtractedFunction({
        name: 'processItems',
        startLine: 10,
        endLine: 12,
        sourceText: 'export function processItems(items) { /* original */ }',
      }),
    ];

    const functionResults: FunctionResult[] = [
      makeFunctionResult({
        name: 'fetchData',
        instrumentedCode: `import { trace } from '@opentelemetry/api';

const tracer = trace.getTracer('my-service');

export async function fetchData(url) {
  return tracer.startActiveSpan('fetchData', async (span) => {
    span.end();
    return {};
  });
}`,
      }),
      makeFunctionResult({
        name: 'processItems',
        instrumentedCode: `import { trace } from '@opentelemetry/api';

const tracer = trace.getTracer('my-service');

export function processItems(items) {
  return tracer.startActiveSpan('processItems', (span) => {
    span.end();
    return items;
  });
}`,
      }),
    ];

    const result = reassembleFunctions(fileWithImports, extractedFunctions, functionResults);

    // Tracer init should appear exactly once
    const tracerInitCount = (result.match(/const tracer = trace\.getTracer/g) || []).length;
    expect(tracerInitCount).toBe(1);
  });

  it('does not insert tracer init when functions use inline trace.getTracer().startActiveSpan()', () => {
    const extractedFunctions: ExtractedFunction[] = [
      makeExtractedFunction({
        name: 'fetchData',
        startLine: 5,
        endLine: 8,
        sourceText: 'export async function fetchData(url) { /* original */ }',
      }),
    ];

    const functionResults: FunctionResult[] = [
      makeFunctionResult({
        name: 'fetchData',
        instrumentedCode: `import { trace } from '@opentelemetry/api';

export async function fetchData(url) {
  return trace.getTracer('my-service').startActiveSpan('fetchData', async (span) => {
    span.end();
    return {};
  });
}`,
      }),
    ];

    const result = reassembleFunctions(fileWithImports, extractedFunctions, functionResults);

    // Should NOT have a standalone tracer init line
    expect(result).not.toMatch(/^const tracer = trace\.getTracer/m);
    // Should still have the inline usage in the function
    expect(result).toContain("trace.getTracer('my-service').startActiveSpan");
  });

  it('does not duplicate tracer init that already exists in the original file', () => {
    const fileWithExistingTracer = `import { trace } from '@opentelemetry/api';

const tracer = trace.getTracer('my-service');

export function existingInstrumented() {
  return tracer.startActiveSpan('existing', (span) => {
    span.end();
  });
}

export function newFunction(x) {
  return x + 1;
}
`;

    const extractedFunctions: ExtractedFunction[] = [
      makeExtractedFunction({
        name: 'newFunction',
        startLine: 11,
        endLine: 13,
        sourceText: 'export function newFunction(x) { return x + 1; }',
      }),
    ];

    const functionResults: FunctionResult[] = [
      makeFunctionResult({
        name: 'newFunction',
        instrumentedCode: `import { trace } from '@opentelemetry/api';

const tracer = trace.getTracer('my-service');

export function newFunction(x) {
  return tracer.startActiveSpan('newFunction', (span) => {
    span.end();
    return x + 1;
  });
}`,
      }),
    ];

    const result = reassembleFunctions(fileWithExistingTracer, extractedFunctions, functionResults);

    // Tracer init should still appear exactly once (the original)
    const tracerInitCount = (result.match(/const tracer = trace\.getTracer/g) || []).length;
    expect(tracerInitCount).toBe(1);
  });
});

describe('ensureTracerAfterImports', () => {
  it('moves tracer init from between imports to after the last import', () => {
    const code = [
      "import { readFile } from 'node:fs/promises';",
      "const tracer = trace.getTracer('commit-story');",
      "import path from 'node:path';",
      '',
      'export function main() {',
      '  return tracer.startActiveSpan("main", (span) => {',
      '    span.end();',
      '  });',
      '}',
    ].join('\n');

    const result = ensureTracerAfterImports(code);

    // Tracer init should be after the last import
    const lines = result.split('\n');
    const lastImportIdx = lines.findLastIndex(l => l.trim().startsWith('import '));
    const tracerIdx = lines.findIndex(l => l.includes('trace.getTracer'));
    expect(tracerIdx).toBeGreaterThan(lastImportIdx);
    // All imports should be contiguous
    expect(result).toContain("import { readFile }");
    expect(result).toContain("import path");
  });

  it('returns code unchanged when tracer init is already after imports', () => {
    const code = [
      "import { readFile } from 'node:fs/promises';",
      "import path from 'node:path';",
      '',
      "const tracer = trace.getTracer('commit-story');",
      '',
      'export function main() {',
      '  return 42;',
      '}',
    ].join('\n');

    const result = ensureTracerAfterImports(code);
    expect(result).toBe(code);
  });

  it('returns code unchanged when there are no imports', () => {
    const code = [
      "const tracer = trace.getTracer('commit-story');",
      '',
      'function main() { return 42; }',
    ].join('\n');

    const result = ensureTracerAfterImports(code);
    expect(result).toBe(code);
  });

  it('returns code unchanged when there is no tracer init', () => {
    const code = [
      "import { readFile } from 'node:fs/promises';",
      '',
      'export function main() { return 42; }',
    ].join('\n');

    const result = ensureTracerAfterImports(code);
    expect(result).toBe(code);
  });
});

describe('reassembleFunctions — JSDoc deduplication (#189)', () => {
  const fileWithJsDoc = `import { readFile } from 'node:fs/promises';

/**
 * Load a config file.
 * @param {string} path - config path
 */
export async function loadConfig(path) {
  const content = await readFile(path, 'utf-8');
  return JSON.parse(content);
}
`;

  it('does not duplicate JSDoc when startLine includes JSDoc range', () => {
    const extractedFunctions: ExtractedFunction[] = [
      makeExtractedFunction({
        name: 'loadConfig',
        // startLine includes the JSDoc block (line 3 = /**)
        startLine: 3,
        endLine: 10,
        sourceText: 'export async function loadConfig(path) {\n  const content = await readFile(path, \'utf-8\');\n  return JSON.parse(content);\n}',
        jsDoc: '/**\n * Load a config file.\n * @param {string} path - config path\n */',
      }),
    ];

    const functionResults: FunctionResult[] = [
      makeFunctionResult({
        name: 'loadConfig',
        instrumentedCode: `import { trace, SpanStatusCode } from '@opentelemetry/api';
import { readFile } from 'node:fs/promises';

const tracer = trace.getTracer('my-service');

/**
 * Load a config file.
 * @param {string} path - config path
 */
export async function loadConfig(path) {
  return tracer.startActiveSpan('svc.config.load', async (span) => {
    try {
      const content = await readFile(path, 'utf-8');
      return JSON.parse(content);
    } catch (error) {
      span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}`,
      }),
    ];

    const result = reassembleFunctions(fileWithJsDoc, extractedFunctions, functionResults);

    // Count JSDoc occurrences — should be exactly 1
    const jsDocCount = (result.match(/Load a config file/g) || []).length;
    expect(jsDocCount).toBe(1);
    // Should have the instrumented version
    expect(result).toContain('startActiveSpan');
  });
});

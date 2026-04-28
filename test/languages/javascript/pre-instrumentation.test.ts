// ABOUTME: Tests for JavaScriptProvider.preInstrumentationAnalysis() — deterministic pre-scan.
// ABOUTME: Covers COV-001, RST-006, COV-004, RST-001, RST-004, COV-002, and hasInstrumentableFunctions.

import { describe, it, expect } from 'vitest';
import { JavaScriptProvider } from '../../../src/languages/javascript/index.ts';

describe('JavaScriptProvider.preInstrumentationAnalysis()', () => {
  const provider = new JavaScriptProvider();

  it('exposes preInstrumentationAnalysis as a callable method', () => {
    // The method is optional on the LanguageProvider interface — callers must check existence.
    // This test confirms JavaScriptProvider implements it.
    expect(typeof provider.preInstrumentationAnalysis).toBe('function');
  });

  describe('COV-001: exported async entry points', () => {
    it('reports an exported async function as an entry point needing a span', () => {
      const source = `
export async function handleRequest(req, res) {
  const data = await fetchData(req.id);
  res.json(data);
}
`.trim();

      const result = provider.preInstrumentationAnalysis!(source);

      expect(result.entryPointsNeedingSpans).toHaveLength(1);
      expect(result.entryPointsNeedingSpans[0].name).toBe('handleRequest');
      expect(result.entryPointsNeedingSpans[0].startLine).toBe(1);
    });

    it('reports a function named main as an entry point regardless of export status', () => {
      const source = `
async function main() {
  await run();
}
`.trim();

      const result = provider.preInstrumentationAnalysis!(source);

      expect(result.entryPointsNeedingSpans.some(f => f.name === 'main')).toBe(true);
    });

    it('does not report unexported async functions as entry points', () => {
      const source = `
async function internal(x) {
  return await fetch(x);
}
`.trim();

      const result = provider.preInstrumentationAnalysis!(source);

      expect(result.entryPointsNeedingSpans.every(f => f.name !== 'internal')).toBe(true);
    });

    it('does not report sync exported functions as entry points', () => {
      const source = `
export function transform(data) {
  return data.map(x => x * 2);
}
`.trim();

      const result = provider.preInstrumentationAnalysis!(source);

      expect(result.entryPointsNeedingSpans).toHaveLength(0);
    });

    it('reports multiple exported async functions', () => {
      const source = `
export async function create(item) {
  return await db.insert(item);
}

export async function remove(id) {
  return await db.delete(id);
}
`.trim();

      const result = provider.preInstrumentationAnalysis!(source);

      expect(result.entryPointsNeedingSpans).toHaveLength(2);
      const names = result.entryPointsNeedingSpans.map(f => f.name);
      expect(names).toContain('create');
      expect(names).toContain('remove');
    });
  });

  describe('RST-006: process.exit() conflict with COV-001', () => {
    it('flags an exported async entry point with direct process.exit() in processExitEntryPoints', () => {
      const source = `
export async function main() {
  const result = await run();
  if (!result.ok) {
    process.exit(1);
  }
}
`.trim();

      const result = provider.preInstrumentationAnalysis!(source);

      expect(result.processExitEntryPoints).toHaveLength(1);
      expect(result.processExitEntryPoints[0].name).toBe('main');
    });

    it('includes constraintNote for process.exit() entry points', () => {
      const source = `
export async function main() {
  const result = await run();
  process.exit(result.code);
}
`.trim();

      const result = provider.preInstrumentationAnalysis!(source);

      const entry = result.processExitEntryPoints[0];
      expect(entry.constraintNote).toBeTruthy();
    });

    it('constraintNote instructs minimal wrapper pattern (COV-001 tiebreaker)', () => {
      const source = `
export async function handleSummarize() {
  const data = await getData();
  process.exit(0);
}
`.trim();

      const result = provider.preInstrumentationAnalysis!(source);
      const note = result.processExitEntryPoints[0]?.constraintNote ?? '';

      // Must instruct span addition (COV-001 wins), not skip
      expect(note).toContain('startActiveSpan');
      // Must specify minimal wrapper constraint
      expect(note.toLowerCase()).toMatch(/minimal wrapper|finally/);
      // Must NOT say to skip instrumentation
      expect(note.toLowerCase()).not.toContain('skip');
      expect(note.toLowerCase()).not.toContain('do not add a span');
    });

    it('process.exit() entry point also appears in entryPointsNeedingSpans', () => {
      // COV-001 wins: the function still needs a span, it's just constrained.
      const source = `
export async function main() {
  process.exit(await getCode());
}
`.trim();

      const result = provider.preInstrumentationAnalysis!(source);

      const names = result.entryPointsNeedingSpans.map(f => f.name);
      expect(names).toContain('main');
    });

    it('constraintNote starts with CRITICAL and includes line number when inner try/catch is present', () => {
      const source = `
async function main() {
  const result = await doWork();
  try {
    await triggerAutoSummaries();
  } catch (err) {
    console.log('auto-summarize failed, continuing');
  }
  process.exit(result.code);
}
`.trim();

      const result = provider.preInstrumentationAnalysis!(source);
      const note = result.processExitEntryPoints[0]?.constraintNote ?? '';

      // CRITICAL must appear first — not buried at the end
      expect(note.startsWith('CRITICAL')).toBe(true);
      // Must include the inner try/catch count
      expect(note).toContain('inner try/catch');
      // Must include a specific line number
      expect(note).toMatch(/at line \d+/);
      // Must instruct placing ALL original lines (not "original body" placeholder)
      expect(note).toMatch(/ALL original lines/);
      // Must include the explicit do-not-omit constraint
      expect(note).toMatch(/do NOT.*omit/i);
    });

    it('does not flag process.exit() only inside a catch block', () => {
      // process.exit() in catch does not exempt the function from spanning.
      const source = `
export async function fetchWithFallback(url) {
  try {
    return await fetch(url);
  } catch (err) {
    process.exit(1);
  }
}
`.trim();

      const result = provider.preInstrumentationAnalysis!(source);

      // Should be in entryPointsNeedingSpans (normal entry point)
      expect(result.entryPointsNeedingSpans.some(f => f.name === 'fetchWithFallback')).toBe(true);
      // Should NOT be flagged as process.exit() entry point
      expect(result.processExitEntryPoints.every(f => f.name !== 'fetchWithFallback')).toBe(true);
    });
  });

  describe('empty / no functions', () => {
    it('returns empty arrays for a file with no function definitions', () => {
      const source = `const x = 42;\nexport default x;`;

      const result = provider.preInstrumentationAnalysis!(source);

      expect(result.entryPointsNeedingSpans).toHaveLength(0);
      expect(result.processExitEntryPoints).toHaveLength(0);
    });

    it('returns empty arrays for an empty string', () => {
      const result = provider.preInstrumentationAnalysis!('');

      expect(result.entryPointsNeedingSpans).toHaveLength(0);
      expect(result.processExitEntryPoints).toHaveLength(0);
    });
  });

  describe('arrow function process.exit() detection (variable-assigned functions)', () => {
    it('flags a variable-assigned async arrow function entry point with process.exit()', () => {
      const source = `
export const handleSummarize = async () => {
  const data = await getData();
  process.exit(0);
};
`.trim();

      const result = provider.preInstrumentationAnalysis!(source);

      expect(result.processExitEntryPoints.some(f => f.name === 'handleSummarize')).toBe(true);
    });

    it('includes the constraintNote for arrow function process.exit() entry points', () => {
      const source = `
export const main = async () => {
  process.exit(await getCode());
};
`.trim();

      const result = provider.preInstrumentationAnalysis!(source);
      const entry = result.processExitEntryPoints.find(f => f.name === 'main');
      expect(entry?.constraintNote).toContain('startActiveSpan');
    });
  });

  describe('COV-004: async non-entry-point functions needing spans', () => {
    it('does not include async functions with direct process.exit() in asyncFunctionsNeedingSpans', () => {
      // COV-004 exception: process.exit() functions should not get spans (same rule as in prompt).
      // This prevents the pre-scan from contradicting the prompt's COV-004 exception.
      const source = `
async function handleSummarize(args) {
  const result = await runSummarize(args);
  if (result.error) {
    process.exit(1);
  }
  process.exit(0);
}

export async function main() {
  await handleSummarize(process.argv.slice(2));
}
`.trim();

      const result = provider.preInstrumentationAnalysis!(source);

      // handleSummarize has direct process.exit() — must NOT appear in COV-004 list
      expect(result.asyncFunctionsNeedingSpans.every(f => f.name !== 'handleSummarize')).toBe(true);
      // main is the entry point and should still appear
      expect(result.entryPointsNeedingSpans.some(f => f.name === 'main')).toBe(true);
    });

    it('reports an unexported async function in asyncFunctionsNeedingSpans', () => {
      const source = `
async function fetchData(id) {
  return await fetch('/api/' + id);
}

export async function handleRequest(req) {
  const data = await fetchData(req.id);
  return data;
}
`.trim();

      const result = provider.preInstrumentationAnalysis!(source);

      expect(result.asyncFunctionsNeedingSpans.some(f => f.name === 'fetchData')).toBe(true);
    });

    it('does not duplicate entry points in asyncFunctionsNeedingSpans', () => {
      const source = `
export async function handleRequest(req) {
  return await fetch('/api');
}
`.trim();

      const result = provider.preInstrumentationAnalysis!(source);

      // handleRequest is an entry point (COV-001), not a COV-004 finding
      expect(result.asyncFunctionsNeedingSpans.every(f => f.name !== 'handleRequest')).toBe(true);
    });

    it('does not report sync functions in asyncFunctionsNeedingSpans', () => {
      const source = `
function transform(data) {
  return data.map(x => x * 2);
}
`.trim();

      const result = provider.preInstrumentationAnalysis!(source);

      expect(result.asyncFunctionsNeedingSpans).toHaveLength(0);
    });

    it('reports variable-assigned async non-entry-point functions', () => {
      const source = `
const queryDb = async (sql) => {
  return await db.query(sql);
};

export async function runReport() {
  return await queryDb('SELECT 1');
}
`.trim();

      const result = provider.preInstrumentationAnalysis!(source);

      expect(result.asyncFunctionsNeedingSpans.some(f => f.name === 'queryDb')).toBe(true);
    });
  });

  describe('RST-001: pure synchronous functions to skip', () => {
    it('reports a sync function in pureSyncFunctions', () => {
      const source = `
function formatDate(d) {
  return d.toISOString();
}
`.trim();

      const result = provider.preInstrumentationAnalysis!(source);

      expect(result.pureSyncFunctions.some(f => f.name === 'formatDate')).toBe(true);
    });

    it('does not report async functions in pureSyncFunctions', () => {
      const source = `
async function fetchData() {
  return await fetch('/api');
}
`.trim();

      const result = provider.preInstrumentationAnalysis!(source);

      expect(result.pureSyncFunctions.every(f => f.name !== 'fetchData')).toBe(true);
    });

    it('reports multiple sync functions', () => {
      const source = `
function add(a, b) { return a + b; }
function multiply(a, b) { return a * b; }
`.trim();

      const result = provider.preInstrumentationAnalysis!(source);

      const names = result.pureSyncFunctions.map(f => f.name);
      expect(names).toContain('add');
      expect(names).toContain('multiply');
    });
  });

  describe('RST-004: unexported functions to skip', () => {
    it('reports an unexported function in unexportedFunctions', () => {
      const source = `
function internal(x) {
  return x * 2;
}
`.trim();

      const result = provider.preInstrumentationAnalysis!(source);

      expect(result.unexportedFunctions.some(f => f.name === 'internal')).toBe(true);
    });

    it('does not report exported functions in unexportedFunctions', () => {
      const source = `
export async function handleRequest(req) {
  return await fetch(req.url);
}
`.trim();

      const result = provider.preInstrumentationAnalysis!(source);

      expect(result.unexportedFunctions.every(f => f.name !== 'handleRequest')).toBe(true);
    });

    it('does not report unexported async functions in unexportedFunctions (they appear in COV-004 instead)', () => {
      const source = `
async function fetchData(id) {
  return await fetch('/api/' + id);
}

export async function handleRequest(req) {
  const data = await fetchData(req.id);
  return data;
}
`.trim();

      const result = provider.preInstrumentationAnalysis!(source);

      // fetchData is unexported and async — COV-004 takes precedence; RST-004 must not also claim it
      expect(result.asyncFunctionsNeedingSpans.some(f => f.name === 'fetchData')).toBe(true);
      expect(result.unexportedFunctions.every(f => f.name !== 'fetchData')).toBe(true);
    });

    it('does not report main in unexportedFunctions (main is treated as entry point)', () => {
      const source = `
async function main() {
  await run();
}
`.trim();

      const result = provider.preInstrumentationAnalysis!(source);

      // main is an entry point (COV-001), not RST-004
      expect(result.unexportedFunctions.every(f => f.name !== 'main')).toBe(true);
    });
  });

  describe('COV-002: outbound calls needing spans', () => {
    it('reports fetch() in an async function as an outbound call', () => {
      const source = `
export async function loadData() {
  const res = await fetch('/api/data');
  return res.json();
}
`.trim();

      const result = provider.preInstrumentationAnalysis!(source);

      const finding = result.outboundCallsNeedingSpans.find(f => f.functionName === 'loadData');
      expect(finding).toBeDefined();
      expect(finding?.calls.length).toBeGreaterThan(0);
    });

    it('reports db.query() as an outbound call', () => {
      const source = `
export async function getUser(id) {
  return await db.query('SELECT * FROM users WHERE id = ?', [id]);
}
`.trim();

      const result = provider.preInstrumentationAnalysis!(source);

      const finding = result.outboundCallsNeedingSpans.find(f => f.functionName === 'getUser');
      expect(finding).toBeDefined();
    });

    it('does not report outbound calls from sync functions', () => {
      const source = `
function buildUrl(base, path) {
  return base + path;
}
`.trim();

      const result = provider.preInstrumentationAnalysis!(source);

      expect(result.outboundCallsNeedingSpans).toHaveLength(0);
    });

    it('returns empty outboundCallsNeedingSpans when no outbound calls exist', () => {
      const source = `
export async function noOp() {
  await Promise.resolve();
}
`.trim();

      const result = provider.preInstrumentationAnalysis!(source);

      // No outbound I/O calls
      expect(result.outboundCallsNeedingSpans).toHaveLength(0);
    });
  });

  describe('M3: local import analysis — entryPointSubOperations', () => {
    it('resolves all-imported sub-operations to importedSubOperations', () => {
      const source = `
import { handleSummarize, handleReport } from './handlers.js';

export async function main() {
  await handleSummarize();
  await handleReport();
}
`.trim();

      const result = provider.preInstrumentationAnalysis!(source);

      const group = result.entryPointSubOperations.find(g => g.entryPointName === 'main');
      expect(group).toBeDefined();
      expect(group!.localSubOperations).toHaveLength(0);
      const importedNames = group!.importedSubOperations.map(s => s.name);
      expect(importedNames).toContain('handleSummarize');
      expect(importedNames).toContain('handleReport');
    });

    it('records the source module for imported sub-operations', () => {
      const source = `
import { fetchData } from './data-access.js';

export async function processRequest(req) {
  const data = await fetchData(req.id);
  return data;
}
`.trim();

      const result = provider.preInstrumentationAnalysis!(source);

      const group = result.entryPointSubOperations.find(g => g.entryPointName === 'processRequest');
      expect(group).toBeDefined();
      const fetchDataEntry = group!.importedSubOperations.find(s => s.name === 'fetchData');
      expect(fetchDataEntry).toBeDefined();
      expect(fetchDataEntry!.sourceModule).toBe('./data-access.js');
    });

    it('resolves mixed local and imported sub-operations', () => {
      const source = `
import { externalService } from './external.js';

async function localHelper(x) {
  return x * 2;
}

export async function main() {
  const result = await localHelper(42);
  return await externalService(result);
}
`.trim();

      const result = provider.preInstrumentationAnalysis!(source);

      const group = result.entryPointSubOperations.find(g => g.entryPointName === 'main');
      expect(group).toBeDefined();
      expect(group!.localSubOperations).toContain('localHelper');
      const importedNames = group!.importedSubOperations.map(s => s.name);
      expect(importedNames).toContain('externalService');
    });

    it('returns empty lists when entry point has no resolvable function calls', () => {
      const source = `
export async function main() {
  const res = await fetch('/api');
  return res.json();
}
`.trim();

      // fetch is a global, not imported or locally defined — omitted from both lists
      const result = provider.preInstrumentationAnalysis!(source);

      const group = result.entryPointSubOperations.find(g => g.entryPointName === 'main');
      // Group may be absent or present with empty lists
      if (group) {
        expect(group.localSubOperations).toHaveLength(0);
        expect(group.importedSubOperations).toHaveLength(0);
      }
    });

    it('does not include method calls (PropertyAccessExpression callees) in sub-operations', () => {
      const source = `
export async function processOrder(order) {
  await order.validate();
  await db.save(order);
}
`.trim();

      const result = provider.preInstrumentationAnalysis!(source);

      const group = result.entryPointSubOperations.find(g => g.entryPointName === 'processOrder');
      // Method calls like order.validate() and db.save() should not appear
      if (group) {
        expect(group.localSubOperations).toHaveLength(0);
        expect(group.importedSubOperations).toHaveLength(0);
      }
    });

    it('returns an empty entryPointSubOperations array when there are no entry points', () => {
      const source = `
function transform(x) { return x * 2; }
`.trim();

      const result = provider.preInstrumentationAnalysis!(source);

      expect(result.entryPointSubOperations).toHaveLength(0);
    });

    it('handles multiple entry points each with their own sub-operations', () => {
      const source = `
import { serviceA } from './a.js';
import { serviceB } from './b.js';

async function localHelper() { return 1; }

export async function handlerA() {
  await serviceA();
  await localHelper();
}

export async function handlerB() {
  await serviceB();
}
`.trim();

      const result = provider.preInstrumentationAnalysis!(source);

      const groupA = result.entryPointSubOperations.find(g => g.entryPointName === 'handlerA');
      const groupB = result.entryPointSubOperations.find(g => g.entryPointName === 'handlerB');

      expect(groupA).toBeDefined();
      expect(groupA!.importedSubOperations.map(s => s.name)).toContain('serviceA');
      expect(groupA!.localSubOperations).toContain('localHelper');

      expect(groupB).toBeDefined();
      expect(groupB!.importedSubOperations.map(s => s.name)).toContain('serviceB');
    });
  });

  describe('M3: aliased import resolution', () => {
    it('resolves aliased imports by the local alias name, not the exported name', () => {
      const source = `
import { summarize as handleSummarize } from './handlers.js';

export async function main() {
  await handleSummarize();
}
`.trim();

      const result = provider.preInstrumentationAnalysis!(source);

      const group = result.entryPointSubOperations.find(g => g.entryPointName === 'main');
      expect(group).toBeDefined();
      // handleSummarize is the alias used at the call site — must appear as imported
      expect(group!.importedSubOperations.map(s => s.name)).toContain('handleSummarize');
      expect(group!.localSubOperations).not.toContain('handleSummarize');
    });
  });

  describe('hasInstrumentableFunctions', () => {
    it('returns true when there are async entry points', () => {
      const source = `
export async function handleRequest(req) {
  return await fetch(req.url);
}
`.trim();

      const result = provider.preInstrumentationAnalysis!(source);

      expect(result.hasInstrumentableFunctions).toBe(true);
    });

    it('returns true when there are async non-entry-point functions', () => {
      const source = `
async function queryDb(sql) {
  return await db.query(sql);
}
`.trim();

      const result = provider.preInstrumentationAnalysis!(source);

      expect(result.hasInstrumentableFunctions).toBe(true);
    });

    it('returns false when all functions are synchronous', () => {
      const source = `
export function transform(data) {
  return data.map(x => x * 2);
}
function helper(x) {
  return x + 1;
}
`.trim();

      const result = provider.preInstrumentationAnalysis!(source);

      expect(result.hasInstrumentableFunctions).toBe(false);
    });

    it('returns false for a re-export file with no function definitions', () => {
      const source = `
export { foo } from './foo.js';
export { bar } from './bar.js';
`.trim();

      const result = provider.preInstrumentationAnalysis!(source);

      expect(result.hasInstrumentableFunctions).toBe(false);
    });

    it('returns false for an empty file', () => {
      const result = provider.preInstrumentationAnalysis!('');

      expect(result.hasInstrumentableFunctions).toBe(false);
    });

    it('returns false for a file with only constants and no functions', () => {
      const source = `const x = 42;\nexport default x;`;

      const result = provider.preInstrumentationAnalysis!(source);

      expect(result.hasInstrumentableFunctions).toBe(false);
    });
  });

  describe('M6: cross-file manifest lookup', () => {
    const fileWithImports = `
import { handleOrder, processPayment } from '/abs/services/orders.js';

export async function main() {
  await handleOrder({ id: 1 });
  await processPayment({ amount: 100 });
}
`.trim();

    it('returns empty alreadyInstrumentedImports when no manifest is provided', () => {
      const result = provider.preInstrumentationAnalysis!(fileWithImports);

      expect(result.alreadyInstrumentedImports).toHaveLength(0);
    });

    it('returns empty alreadyInstrumentedImports when manifest is empty', () => {
      const manifest = new Map<string, string[]>();

      const result = provider.preInstrumentationAnalysis!(
        fileWithImports,
        manifest,
        '/abs/app/index.js',
      );

      expect(result.alreadyInstrumentedImports).toHaveLength(0);
    });

    it('identifies imported functions that appear in the manifest as already instrumented', () => {
      const manifest = new Map<string, string[]>([
        ['/abs/services/orders.js', ['handleOrder', 'processPayment']],
      ]);

      const result = provider.preInstrumentationAnalysis!(
        fileWithImports,
        manifest,
        '/abs/app/index.js',
      );

      expect(result.alreadyInstrumentedImports).toHaveLength(2);
      const names = result.alreadyInstrumentedImports.map(i => i.name);
      expect(names).toContain('handleOrder');
      expect(names).toContain('processPayment');
    });

    it('resolves the source module path relative to the current file path', () => {
      const sourceWithRelativeImport = `
import { fetchUser } from './utils/users.js';

export async function main() {
  const user = await fetchUser(1);
}
`.trim();

      const manifest = new Map<string, string[]>([
        ['/abs/app/utils/users.js', ['fetchUser']],
      ]);

      const result = provider.preInstrumentationAnalysis!(
        sourceWithRelativeImport,
        manifest,
        '/abs/app/index.js',
      );

      expect(result.alreadyInstrumentedImports).toHaveLength(1);
      expect(result.alreadyInstrumentedImports[0].name).toBe('fetchUser');
      expect(result.alreadyInstrumentedImports[0].sourceModule).toBe('./utils/users.js');
    });

    it('only marks functions that appear in the manifest — not all imports', () => {
      const manifest = new Map<string, string[]>([
        ['/abs/services/orders.js', ['handleOrder']],
        // processPayment is NOT in the manifest for this file
      ]);

      const result = provider.preInstrumentationAnalysis!(
        fileWithImports,
        manifest,
        '/abs/app/index.js',
      );

      const names = result.alreadyInstrumentedImports.map(i => i.name);
      expect(names).toContain('handleOrder');
      expect(names).not.toContain('processPayment');
    });

    it('does not duplicate entries when the same imported function appears in multiple entry points', () => {
      const sourceWithTwoEntryPoints = `
import { sharedHelper } from '/abs/services/helpers.js';

export async function entryA() {
  await sharedHelper();
}

export async function entryB() {
  await sharedHelper();
}
`.trim();

      const manifest = new Map<string, string[]>([
        ['/abs/services/helpers.js', ['sharedHelper']],
      ]);

      const result = provider.preInstrumentationAnalysis!(
        sourceWithTwoEntryPoints,
        manifest,
        '/abs/app/index.js',
      );

      expect(result.alreadyInstrumentedImports).toHaveLength(1);
      expect(result.alreadyInstrumentedImports[0].name).toBe('sharedHelper');
    });

    it('is unaffected by manifest when filePath is not provided', () => {
      const manifest = new Map<string, string[]>([
        ['/abs/services/orders.js', ['handleOrder']],
      ]);

      const result = provider.preInstrumentationAnalysis!(fileWithImports, manifest);

      expect(result.alreadyInstrumentedImports).toHaveLength(0);
    });
  });
});

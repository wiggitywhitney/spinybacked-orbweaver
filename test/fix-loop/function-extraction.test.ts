// ABOUTME: Tests for function extraction module (PRD #106).
// ABOUTME: Verifies extraction of exported functions with dependencies for function-level instrumentation.

import { describe, it, expect } from 'vitest';
import { Project } from 'ts-morph';
import { join } from 'node:path';
import {
  extractExportedFunctions,
  type ExtractedFunction,
} from '../../src/fix-loop/function-extraction.ts';

const FIXTURES_DIR = join(import.meta.dirname, '..', 'fixtures', 'ast');

function getSourceFile(fileName: string) {
  const project = new Project({
    compilerOptions: { allowJs: true, noEmit: true },
    skipAddingFilesFromTsConfig: true,
  });
  return project.addSourceFileAtPath(join(FIXTURES_DIR, fileName));
}

function findByName(functions: ExtractedFunction[], name: string): ExtractedFunction | undefined {
  return functions.find(f => f.name === name);
}

describe('extractExportedFunctions', () => {
  describe('complex-module.js fixture', () => {
    it('extracts only non-trivial, non-instrumented, exported functions', () => {
      const sourceFile = getSourceFile('complex-module.js');
      const result = extractExportedFunctions(sourceFile);

      const names = result.map(f => f.name);
      // Should include: fetchWithRetry, loadConfig, saveData, transformData
      // Should exclude: processRequest (already instrumented), getVersion (trivial),
      //                 getName (trivial), retryDelay (not exported)
      expect(names).toContain('fetchWithRetry');
      expect(names).toContain('loadConfig');
      expect(names).toContain('saveData');
      expect(names).toContain('transformData');
      expect(names).not.toContain('processRequest');
      expect(names).not.toContain('getVersion');
      expect(names).not.toContain('getName');
      expect(names).not.toContain('retryDelay');
    });

    it('returns 4 extractable functions', () => {
      const sourceFile = getSourceFile('complex-module.js');
      const result = extractExportedFunctions(sourceFile);
      expect(result.length).toBe(4);
    });

    it('includes function source text', () => {
      const sourceFile = getSourceFile('complex-module.js');
      const result = extractExportedFunctions(sourceFile);

      const fetchFn = findByName(result, 'fetchWithRetry')!;
      expect(fetchFn.sourceText).toContain('export async function fetchWithRetry');
      expect(fetchFn.sourceText).toContain('throw lastError');
    });

    it('includes JSDoc for functions that have it', () => {
      const sourceFile = getSourceFile('complex-module.js');
      const result = extractExportedFunctions(sourceFile);

      const fetchFn = findByName(result, 'fetchWithRetry')!;
      expect(fetchFn.jsDoc).toContain('Fetch a resource with retry logic');
    });

    it('includes referenced module-level constants', () => {
      const sourceFile = getSourceFile('complex-module.js');
      const result = extractExportedFunctions(sourceFile);

      const fetchFn = findByName(result, 'fetchWithRetry')!;
      expect(fetchFn.referencedConstants).toContain('MAX_RETRIES');
      expect(fetchFn.referencedConstants).toContain('DEFAULT_TIMEOUT');
      // Should NOT include CACHE since fetchWithRetry doesn't reference it
      expect(fetchFn.referencedConstants).not.toContain('CACHE');
    });

    it('includes referenced imports', () => {
      const sourceFile = getSourceFile('complex-module.js');
      const result = extractExportedFunctions(sourceFile);

      const loadConfigFn = findByName(result, 'loadConfig')!;
      // loadConfig uses readFile and path
      expect(loadConfigFn.referencedImports).toContain('readFile');
      expect(loadConfigFn.referencedImports).toContain('path');
      // Should NOT include writeFile since loadConfig doesn't use it
      expect(loadConfigFn.referencedImports).not.toContain('writeFile');
    });

    it('includes start and end lines', () => {
      const sourceFile = getSourceFile('complex-module.js');
      const result = extractExportedFunctions(sourceFile);

      const fetchFn = findByName(result, 'fetchWithRetry')!;
      expect(fetchFn.startLine).toBeGreaterThan(0);
      expect(fetchFn.endLine).toBeGreaterThan(fetchFn.startLine);
    });

    it('startLine includes JSDoc when present (#189)', () => {
      const sourceFile = getSourceFile('complex-module.js');
      const result = extractExportedFunctions(sourceFile);

      // fetchWithRetry has JSDoc starting at line 10, function at line 16
      const fetchFn = findByName(result, 'fetchWithRetry')!;
      expect(fetchFn.jsDoc).toBeDefined();
      // startLine should include the JSDoc block, not just the function keyword
      expect(fetchFn.startLine).toBe(10);
    });

    it('reports isAsync correctly', () => {
      const sourceFile = getSourceFile('complex-module.js');
      const result = extractExportedFunctions(sourceFile);

      const fetchFn = findByName(result, 'fetchWithRetry')!;
      expect(fetchFn.isAsync).toBe(true);

      const transformFn = findByName(result, 'transformData')!;
      expect(transformFn.isAsync).toBe(true);
    });

    it('detects CACHE reference in transformData', () => {
      const sourceFile = getSourceFile('complex-module.js');
      const result = extractExportedFunctions(sourceFile);

      const transformFn = findByName(result, 'transformData')!;
      expect(transformFn.referencedConstants).toContain('CACHE');
    });

    it('includes saveData with correct import references', () => {
      const sourceFile = getSourceFile('complex-module.js');
      const result = extractExportedFunctions(sourceFile);

      const saveFn = findByName(result, 'saveData')!;
      expect(saveFn.referencedImports).toContain('writeFile');
      expect(saveFn.referencedImports).not.toContain('readFile');
    });
  });

  describe('buildFunctionContext', () => {
    it('assembles a complete snippet with imports, constants, and function', () => {
      const sourceFile = getSourceFile('complex-module.js');
      const result = extractExportedFunctions(sourceFile);

      const fetchFn = findByName(result, 'fetchWithRetry')!;
      const context = fetchFn.buildContext(sourceFile);

      // Should contain the relevant imports
      expect(context).toContain('// Module-level constants referenced by this function');
      expect(context).toContain('MAX_RETRIES');
      expect(context).toContain('DEFAULT_TIMEOUT');
      // Should contain the function itself
      expect(context).toContain('export async function fetchWithRetry');
      // Should NOT contain unrelated constants
      expect(context).not.toContain('CACHE');
    });

    it('includes only used imports in context', () => {
      const sourceFile = getSourceFile('complex-module.js');
      const result = extractExportedFunctions(sourceFile);

      const loadConfigFn = findByName(result, 'loadConfig')!;
      const context = loadConfigFn.buildContext(sourceFile);

      expect(context).toContain('readFile');
      expect(context).toContain('path');
      // writeFile is imported but not used by loadConfig
      expect(context).not.toContain('writeFile');
    });
  });

  describe('re-export block pattern (export { a, b, c })', () => {
    it('extracts functions exported via re-export block', () => {
      const project = new Project({
        compilerOptions: { allowJs: true, noEmit: true },
        skipAddingFilesFromTsConfig: true,
      });
      const sourceFile = project.createSourceFile('reexport.js', `
import { ChatAnthropic } from '@langchain/anthropic';

const MODEL_TEMP = 0.7;

async function summaryNode(state) {
  const { context } = state;
  const model = new ChatAnthropic({ temperature: MODEL_TEMP });
  const result = await model.invoke([]);
  return { summary: result.content };
}

async function technicalNode(state) {
  const { context } = state;
  const model = new ChatAnthropic({ temperature: 0.1 });
  const result = await model.invoke([]);
  return { technical: result.content };
}

function trivialHelper() {
  return 42;
}

export { summaryNode, technicalNode, trivialHelper };
      `);
      const result = extractExportedFunctions(sourceFile);
      const names = result.map(f => f.name);

      // summaryNode and technicalNode have 4 statements each — should be extracted
      expect(names).toContain('summaryNode');
      expect(names).toContain('technicalNode');
      // trivialHelper has 1 statement — should be filtered as trivial
      expect(names).not.toContain('trivialHelper');
    });

    it('tracks dependencies for re-exported functions', () => {
      const project = new Project({
        compilerOptions: { allowJs: true, noEmit: true },
        skipAddingFilesFromTsConfig: true,
      });
      const sourceFile = project.createSourceFile('reexport-deps.js', `
import { readFile } from 'node:fs/promises';

const BASE_PATH = '/data';

async function loadData(name) {
  const fullPath = BASE_PATH + '/' + name;
  const content = await readFile(fullPath, 'utf-8');
  const parsed = JSON.parse(content);
  return parsed;
}

export { loadData };
      `);
      const result = extractExportedFunctions(sourceFile);
      expect(result.length).toBe(1);

      const fn = result[0];
      expect(fn.name).toBe('loadData');
      expect(fn.isAsync).toBe(true);
      expect(fn.referencedConstants).toContain('BASE_PATH');
      expect(fn.referencedImports).toContain('readFile');
    });

    it('extracts functions whose body is a single try-catch (common async pattern)', () => {
      const project = new Project({
        compilerOptions: { allowJs: true, noEmit: true },
        skipAddingFilesFromTsConfig: true,
      });
      // This mirrors the journal-graph.js pattern: async function with try/catch wrapper
      const sourceFile = project.createSourceFile('trycatch-pattern.js', `
async function nodeHandler(state) {
  try {
    const { context } = state;
    const model = getModel(0.7);
    const result = await model.invoke([]);
    const cleaned = cleanOutput(result.content);
    return { output: cleaned };
  } catch (error) {
    return { output: '[Generation failed]', errors: [error.message] };
  }
}

export { nodeHandler };
      `);
      const result = extractExportedFunctions(sourceFile);
      // The function has 1 top-level statement (try/catch) but is clearly non-trivial
      expect(result.length).toBe(1);
      expect(result[0].name).toBe('nodeHandler');
    });

    it('extracts arrow functions re-exported via export block', () => {
      const project = new Project({
        compilerOptions: { allowJs: true, noEmit: true },
        skipAddingFilesFromTsConfig: true,
      });
      const sourceFile = project.createSourceFile('arrow-reexport.js', `
const helperFn = async (x) => {
  const a = x + 1;
  const b = a * 2;
  const c = b - 3;
  return c;
};

export { helperFn };
      `);
      const result = extractExportedFunctions(sourceFile);
      const names = result.map(f => f.name);

      expect(names).toContain('helperFn');
      expect(result.length).toBe(1);
    });

    it('handles mixed export styles (inline export + re-export block)', () => {
      const project = new Project({
        compilerOptions: { allowJs: true, noEmit: true },
        skipAddingFilesFromTsConfig: true,
      });
      const sourceFile = project.createSourceFile('mixed-exports.js', `
export async function inlineExported(a, b) {
  const x = a + b;
  const y = x * 2;
  const z = y - 1;
  return z;
}

async function reExported(a, b) {
  const x = a + b;
  const y = x * 2;
  const z = y - 1;
  return z;
}

export { reExported };
      `);
      const result = extractExportedFunctions(sourceFile);
      const names = result.map(f => f.name);

      expect(names).toContain('inlineExported');
      expect(names).toContain('reExported');
      expect(result.length).toBe(2);
    });
  });

  describe('edge cases', () => {
    it('returns empty array for file with no exported functions', () => {
      const project = new Project({
        compilerOptions: { allowJs: true, noEmit: true },
        skipAddingFilesFromTsConfig: true,
      });
      const sourceFile = project.createSourceFile('empty.js', `
        function internalOnly() {
          console.log('hello');
          console.log('world');
          return 42;
        }
      `);
      const result = extractExportedFunctions(sourceFile);
      expect(result).toEqual([]);
    });

    it('skips functions with fewer than 3 statements', () => {
      const project = new Project({
        compilerOptions: { allowJs: true, noEmit: true },
        skipAddingFilesFromTsConfig: true,
      });
      const sourceFile = project.createSourceFile('trivial.js', `
        export function tiny() {
          return 1;
        }
        export function alsoTiny(x) {
          return x + 1;
        }
      `);
      const result = extractExportedFunctions(sourceFile);
      expect(result).toEqual([]);
    });

    it('skips functions that contain OTel span patterns', () => {
      const project = new Project({
        compilerOptions: { allowJs: true, noEmit: true },
        skipAddingFilesFromTsConfig: true,
      });
      const sourceFile = project.createSourceFile('instrumented.js', `
        export function alreadyInstrumented(req) {
          return tracer.startActiveSpan('alreadyInstrumented', (span) => {
            const result = doWork(req);
            span.end();
            return result;
          });
        }
      `);
      const result = extractExportedFunctions(sourceFile);
      expect(result).toEqual([]);
    });
  });

  describe('includeNonExported option', () => {
    it('excludes non-exported functions by default', () => {
      const project = new Project({
        compilerOptions: { allowJs: true, noEmit: true },
        skipAddingFilesFromTsConfig: true,
      });
      const sourceFile = project.createSourceFile('mixed.js', `
function internalHelper(x) {
  const a = x + 1;
  const b = a * 2;
  const c = b - 3;
  return c;
}

export function publicApi(x) {
  const a = internalHelper(x);
  const b = a + 10;
  const c = b * 3;
  return c;
}
      `);
      const result = extractExportedFunctions(sourceFile);
      const names = result.map(f => f.name);
      expect(names).toContain('publicApi');
      expect(names).not.toContain('internalHelper');
    });

    it('includes non-exported functions when includeNonExported is true', () => {
      const project = new Project({
        compilerOptions: { allowJs: true, noEmit: true },
        skipAddingFilesFromTsConfig: true,
      });
      const sourceFile = project.createSourceFile('mixed2.js', `
function internalHelper(x) {
  const a = x + 1;
  const b = a * 2;
  const c = b - 3;
  return c;
}

export function publicApi(x) {
  const a = internalHelper(x);
  const b = a + 10;
  const c = b * 3;
  return c;
}
      `);
      const result = extractExportedFunctions(sourceFile, { includeNonExported: true });
      const names = result.map(f => f.name);
      expect(names).toContain('publicApi');
      expect(names).toContain('internalHelper');
    });

    it('still filters trivial non-exported functions', () => {
      const project = new Project({
        compilerOptions: { allowJs: true, noEmit: true },
        skipAddingFilesFromTsConfig: true,
      });
      const sourceFile = project.createSourceFile('trivial-internal.js', `
function trivialHelper() {
  return 42;
}

function nonTrivial(x) {
  const a = x + 1;
  const b = a * 2;
  const c = b - 3;
  return c;
}

export function main() {
  const a = nonTrivial(1);
  const b = trivialHelper();
  const c = a + b;
  return c;
}
      `);
      const result = extractExportedFunctions(sourceFile, { includeNonExported: true });
      const names = result.map(f => f.name);
      expect(names).toContain('main');
      expect(names).toContain('nonTrivial');
      expect(names).not.toContain('trivialHelper');
    });
  });
});

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
});

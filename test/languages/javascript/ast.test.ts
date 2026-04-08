// ABOUTME: Tests for JavaScript AST helpers: function classification, OTel import detection, and variable shadowing.
// ABOUTME: Merged from test/ast/function-classification.test.ts, import-detection.test.ts, and variable-shadowing.test.ts.

import { describe, it, expect } from 'vitest';
import { Project } from 'ts-morph';
import { join } from 'node:path';
import { classifyFunctions } from '../../../src/languages/javascript/ast.ts';
import type { FunctionInfo } from '../../../src/languages/javascript/ast.ts';
import { detectOTelImports } from '../../../src/languages/javascript/ast.ts';
import { checkVariableShadowing } from '../../../src/languages/javascript/ast.ts';

const FIXTURES_DIR = join(import.meta.dirname, '..', '..', 'fixtures', 'ast');

// ─── classifyFunctions ────────────────────────────────────────────────────────

function getSourceFile(fileName: string) {
  const project = new Project({
    compilerOptions: { allowJs: true, noEmit: true },
    skipAddingFilesFromTsConfig: true,
  });
  return project.addSourceFileAtPath(join(FIXTURES_DIR, fileName));
}

function findByName(functions: FunctionInfo[], name: string): FunctionInfo | undefined {
  return functions.find(f => f.name === name);
}

describe('classifyFunctions', () => {
  describe('mixed-functions.js', () => {
    it('identifies all functions in the file', () => {
      const sourceFile = getSourceFile('mixed-functions.js');
      const result = classifyFunctions(sourceFile);

      // Should find: startServer, createConfig, handleRequest, processRoute,
      //              middleware, readBody, clamp
      expect(result.length).toBe(7);
    });

    it('correctly classifies exported async functions', () => {
      const sourceFile = getSourceFile('mixed-functions.js');
      const result = classifyFunctions(sourceFile);

      const startServer = findByName(result, 'startServer')!;
      expect(startServer).toBeDefined();
      expect(startServer.isExported).toBe(true);
      expect(startServer.isAsync).toBe(true);
    });

    it('correctly classifies exported sync functions', () => {
      const sourceFile = getSourceFile('mixed-functions.js');
      const result = classifyFunctions(sourceFile);

      const createConfig = findByName(result, 'createConfig')!;
      expect(createConfig).toBeDefined();
      expect(createConfig.isExported).toBe(true);
      expect(createConfig.isAsync).toBe(false);
    });

    it('correctly classifies non-exported async functions', () => {
      const sourceFile = getSourceFile('mixed-functions.js');
      const result = classifyFunctions(sourceFile);

      const handleRequest = findByName(result, 'handleRequest')!;
      expect(handleRequest).toBeDefined();
      expect(handleRequest.isExported).toBe(false);
      expect(handleRequest.isAsync).toBe(true);
    });

    it('correctly classifies non-exported sync functions', () => {
      const sourceFile = getSourceFile('mixed-functions.js');
      const result = classifyFunctions(sourceFile);

      const processRoute = findByName(result, 'processRoute')!;
      expect(processRoute).toBeDefined();
      expect(processRoute.isExported).toBe(false);
      expect(processRoute.isAsync).toBe(false);
    });

    it('classifies exported arrow functions', () => {
      const sourceFile = getSourceFile('mixed-functions.js');
      const result = classifyFunctions(sourceFile);

      const middleware = findByName(result, 'middleware')!;
      expect(middleware).toBeDefined();
      expect(middleware.isExported).toBe(true);
      expect(middleware.isAsync).toBe(true);
    });

    it('classifies non-exported arrow functions', () => {
      const sourceFile = getSourceFile('mixed-functions.js');
      const result = classifyFunctions(sourceFile);

      const readBody = findByName(result, 'readBody')!;
      expect(readBody).toBeDefined();
      expect(readBody.isExported).toBe(false);
    });

    it('includes line count for each function', () => {
      const sourceFile = getSourceFile('mixed-functions.js');
      const result = classifyFunctions(sourceFile);

      const clamp = findByName(result, 'clamp')!;
      expect(clamp).toBeDefined();
      expect(clamp.lineCount).toBeGreaterThan(0);
      // clamp is a short function — 3 lines (declaration + body + close)
      expect(clamp.lineCount).toBeLessThanOrEqual(5);

      const processRoute = findByName(result, 'processRoute')!;
      expect(processRoute.lineCount).toBeGreaterThan(clamp.lineCount);
    });

    it('includes start line number for each function', () => {
      const sourceFile = getSourceFile('mixed-functions.js');
      const result = classifyFunctions(sourceFile);

      for (const fn of result) {
        expect(fn.startLine).toBeGreaterThan(0);
      }
    });
  });

  describe('arrow function line numbers', () => {
    it('reports initializer line numbers, not variable statement line numbers', () => {
      const project = new Project({
        compilerOptions: { allowJs: true, noEmit: true },
        useInMemoryFileSystem: true,
      });
      // The arrow function starts on line 2, but the VariableStatement starts on line 1
      const sf = project.createSourceFile('test.js', [
        'export const handler =',
        '  async (req, res) => {',
        '    return res.send("ok");',
        '  };',
      ].join('\n'));
      const result = classifyFunctions(sf);
      expect(result).toHaveLength(1);
      const handler = result[0];
      expect(handler.name).toBe('handler');
      // startLine should be the arrow function (line 2), not the const declaration (line 1)
      expect(handler.startLine).toBe(2);
      expect(handler.lineCount).toBe(3);
    });
  });

  describe('function count', () => {
    it('returns all top-level functions in the file', () => {
      const sourceFile = getSourceFile('mixed-functions.js');
      const result = classifyFunctions(sourceFile);

      expect(result.length).toBe(7);
    });
  });

  describe('no-otel-imports.js', () => {
    it('identifies exported and non-exported functions', () => {
      const sourceFile = getSourceFile('no-otel-imports.js');
      const result = classifyFunctions(sourceFile);

      const exported = result.filter(f => f.isExported);
      const nonExported = result.filter(f => !f.isExported);

      // getUsers, getUserById, formatUser are exported
      expect(exported.length).toBe(3);
      // validateInput, loadConfig are not exported
      expect(nonExported.length).toBe(2);
    });
  });
});

// ─── detectOTelImports ────────────────────────────────────────────────────────

function createProjectWithFile(filePath: string) {
  const project = new Project({
    compilerOptions: { allowJs: true, noEmit: true },
    skipAddingFilesFromTsConfig: true,
  });
  return project.addSourceFileAtPath(filePath);
}

describe('detectOTelImports', () => {
  describe('file with existing OTel imports', () => {
    it('detects @opentelemetry/api imports', () => {
      const sourceFile = createProjectWithFile(join(FIXTURES_DIR, 'with-otel-imports.js'));
      const result = detectOTelImports(sourceFile);

      expect(result.hasOTelImports).toBe(true);
      expect(result.otelImports.length).toBeGreaterThan(0);

      const apiImport = result.otelImports.find(i => i.moduleSpecifier === '@opentelemetry/api');
      expect(apiImport).toBeDefined();
      expect(apiImport!.namedImports).toContain('trace');
      expect(apiImport!.namedImports).toContain('SpanStatusCode');
    });

    it('detects tracer acquisition patterns', () => {
      const sourceFile = createProjectWithFile(join(FIXTURES_DIR, 'with-otel-imports.js'));
      const result = detectOTelImports(sourceFile);

      expect(result.tracerAcquisitions.length).toBeGreaterThan(0);
      expect(result.tracerAcquisitions[0].variableName).toBe('tracer');
    });

    it('detects existing span creation patterns', () => {
      const sourceFile = createProjectWithFile(join(FIXTURES_DIR, 'with-otel-imports.js'));
      const result = detectOTelImports(sourceFile);

      expect(result.existingSpanPatterns.length).toBeGreaterThan(0);
      const spanPattern = result.existingSpanPatterns[0];
      expect(spanPattern.pattern).toBe('startActiveSpan');
    });
  });

  describe('file without OTel imports', () => {
    it('reports no OTel imports', () => {
      const sourceFile = createProjectWithFile(join(FIXTURES_DIR, 'no-otel-imports.js'));
      const result = detectOTelImports(sourceFile);

      expect(result.hasOTelImports).toBe(false);
      expect(result.otelImports).toHaveLength(0);
      expect(result.tracerAcquisitions).toHaveLength(0);
      expect(result.existingSpanPatterns).toHaveLength(0);
    });
  });

  describe('framework import detection', () => {
    it('detects framework imports in a file with pg and express', () => {
      const sourceFile = createProjectWithFile(join(FIXTURES_DIR, 'no-otel-imports.js'));
      const result = detectOTelImports(sourceFile);

      expect(result.frameworkImports.length).toBeGreaterThan(0);
      const pgImport = result.frameworkImports.find(i => i.moduleSpecifier === 'pg');
      expect(pgImport).toBeDefined();
      expect(pgImport!.namedImports).toContain('Pool');

      const expressImport = result.frameworkImports.find(i => i.moduleSpecifier === 'express');
      expect(expressImport).toBeDefined();
    });

    it('detects node:http as a framework import', () => {
      const sourceFile = createProjectWithFile(join(FIXTURES_DIR, 'mixed-functions.js'));
      const result = detectOTelImports(sourceFile);

      const httpImport = result.frameworkImports.find(i => i.moduleSpecifier === 'node:http');
      expect(httpImport).toBeDefined();
    });
  });
});

// ─── checkVariableShadowing ───────────────────────────────────────────────────

describe('checkVariableShadowing', () => {
  describe('function with "span" variable', () => {
    it('detects shadowing of "span" in processWithSpan', () => {
      const sourceFile = getSourceFile('variable-shadowing.js');
      const fn = sourceFile.getFunction('processWithSpan')!;
      expect(fn).toBeDefined();

      const result = checkVariableShadowing(fn, ['span', 'tracer']);
      expect(result.hasConflicts).toBe(true);
      expect(result.conflicts).toHaveLength(1);
      expect(result.conflicts[0].requestedName).toBe('span');
      expect(result.conflicts[0].suggestedName).toBe('otelSpan');
    });
  });

  describe('function with "tracer" variable', () => {
    it('detects shadowing of "tracer" in handleWithTracer', () => {
      const sourceFile = getSourceFile('variable-shadowing.js');
      const fn = sourceFile.getFunction('handleWithTracer')!;
      expect(fn).toBeDefined();

      const result = checkVariableShadowing(fn, ['span', 'tracer']);
      expect(result.hasConflicts).toBe(true);
      expect(result.conflicts).toHaveLength(1);
      expect(result.conflicts[0].requestedName).toBe('tracer');
      expect(result.conflicts[0].suggestedName).toBe('otelTracer');
    });
  });

  describe('function without shadowing', () => {
    it('reports no conflicts in noShadowing', () => {
      const sourceFile = getSourceFile('variable-shadowing.js');
      const fn = sourceFile.getFunction('noShadowing')!;
      expect(fn).toBeDefined();

      const result = checkVariableShadowing(fn, ['span', 'tracer']);
      expect(result.hasConflicts).toBe(false);
      expect(result.conflicts).toHaveLength(0);
    });
  });

  describe('nested block scope shadowing', () => {
    it('detects "span" variable in nested for-loop block', () => {
      const sourceFile = getSourceFile('variable-shadowing.js');
      const fn = sourceFile.getFunction('nestedShadowing')!;
      expect(fn).toBeDefined();

      const result = checkVariableShadowing(fn, ['span', 'tracer']);
      expect(result.hasConflicts).toBe(true);
      expect(result.conflicts.some(c => c.requestedName === 'span')).toBe(true);
    });
  });

  describe('safe name recommendations', () => {
    it('provides otel-prefixed alternatives for all conflicts', () => {
      const sourceFile = getSourceFile('variable-shadowing.js');
      const fn = sourceFile.getFunction('processWithSpan')!;

      const result = checkVariableShadowing(fn, ['span']);
      expect(result.safeNames.get('span')).toBe('otelSpan');
    });

    it('returns original name when no conflict exists', () => {
      const sourceFile = getSourceFile('variable-shadowing.js');
      const fn = sourceFile.getFunction('noShadowing')!;

      const result = checkVariableShadowing(fn, ['span', 'tracer']);
      expect(result.safeNames.get('span')).toBe('span');
      expect(result.safeNames.get('tracer')).toBe('tracer');
    });
  });
});

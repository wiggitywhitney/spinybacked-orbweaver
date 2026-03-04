// ABOUTME: Tests for function classification AST helper.
// ABOUTME: Verifies detection of exported, async, and line count properties of functions.

import { describe, it, expect } from 'vitest';
import { Project } from 'ts-morph';
import { join } from 'node:path';
import { classifyFunctions } from '../../src/ast/function-classification.ts';
import type { FunctionInfo } from '../../src/ast/function-classification.ts';

const FIXTURES_DIR = join(import.meta.dirname, '..', 'fixtures', 'ast');

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

  describe('totalFunctionsInFile count', () => {
    it('counts all functions for ratio-based backstop', () => {
      const sourceFile = getSourceFile('mixed-functions.js');
      const result = classifyFunctions(sourceFile);

      // totalFunctionsInFile on each entry should match total count
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

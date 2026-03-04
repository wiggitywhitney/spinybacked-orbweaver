// ABOUTME: Tests for OTel import detection AST helper.
// ABOUTME: Verifies detection of existing OpenTelemetry imports and tracer patterns in JS files.

import { describe, it, expect } from 'vitest';
import { Project } from 'ts-morph';
import { join } from 'node:path';
import { detectOTelImports } from '../../src/ast/import-detection.ts';

const FIXTURES_DIR = join(import.meta.dirname, '..', 'fixtures', 'ast');

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

// ABOUTME: Tests for variable shadowing detection AST helper.
// ABOUTME: Verifies scope-based collision detection for OTel variable names (span, tracer).

import { describe, it, expect } from 'vitest';
import { Project } from 'ts-morph';
import { join } from 'node:path';
import { checkVariableShadowing } from '../../src/ast/variable-shadowing.ts';

const FIXTURES_DIR = join(import.meta.dirname, '..', 'fixtures', 'ast');

function getSourceFile(fileName: string) {
  const project = new Project({
    compilerOptions: { allowJs: true, noEmit: true },
    skipAddingFilesFromTsConfig: true,
  });
  return project.addSourceFileAtPath(join(FIXTURES_DIR, fileName));
}

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

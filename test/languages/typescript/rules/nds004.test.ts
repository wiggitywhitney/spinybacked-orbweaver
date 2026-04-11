// ABOUTME: Tests for TypeScript NDS-004 Tier 2 check — signature preservation.
// ABOUTME: Verifies that type annotations in params are handled correctly (not treated as param changes).

import { describe, it, expect } from 'vitest';
import { checkExportedSignaturePreservationTs } from '../../../../src/languages/typescript/rules/nds004.ts';

describe('checkExportedSignaturePreservationTs (NDS-004 TypeScript)', () => {
  const filePath = '/tmp/test-file.ts';

  describe('applicableTo', () => {
    it('rule applies to TypeScript', async () => {
      const { nds004TsRule } = await import('../../../../src/languages/typescript/rules/nds004.ts');
      expect(nds004TsRule.applicableTo('typescript')).toBe(true);
    });

    it('rule does not apply to JavaScript', async () => {
      const { nds004TsRule } = await import('../../../../src/languages/typescript/rules/nds004.ts');
      expect(nds004TsRule.applicableTo('javascript')).toBe(false);
    });
  });

  describe('TypeScript type annotations in parameters', () => {
    it('passes when parameters have type annotations and names are preserved', () => {
      const original = [
        "import type { Request, Response } from 'express';",
        'export async function getUser(req: Request, res: Response): Promise<void> {',
        '  res.json({});',
        '}',
      ].join('\n');

      const instrumented = [
        "import { trace } from '@opentelemetry/api';",
        "import type { Request, Response } from 'express';",
        'const tracer = trace.getTracer("svc");',
        'export async function getUser(req: Request, res: Response): Promise<void> {',
        '  return tracer.startActiveSpan("getUser", async (span) => {',
        '    try {',
        '      res.json({});',
        '    } finally {',
        '      span.end();',
        '    }',
        '  });',
        '}',
      ].join('\n');

      const results = checkExportedSignaturePreservationTs(original, instrumented, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('flags when instrumented code strips type annotations and renames params', () => {
      const original = [
        "import type { Request, Response } from 'express';",
        'export async function getUser(req: Request, res: Response): Promise<void> {',
        '  res.json({});',
        '}',
      ].join('\n');

      // Instrumented code renamed req→request and res→response (wrong!)
      const instrumented = [
        "import { trace } from '@opentelemetry/api';",
        'export async function getUser(request: any, response: any): Promise<void> {',
        '  response.json({});',
        '}',
      ].join('\n');

      const results = checkExportedSignaturePreservationTs(original, instrumented, filePath);
      expect(results.some(r => !r.passed)).toBe(true);
      expect(results[0].ruleId).toBe('NDS-004');
    });

    it('passes when generic type parameters are in the signature', () => {
      const original = [
        'export function identity<T>(value: T): T {',
        '  return value;',
        '}',
      ].join('\n');

      const instrumented = [
        "import { trace } from '@opentelemetry/api';",
        'const tracer = trace.getTracer("svc");',
        'export function identity<T>(value: T): T {',
        '  return tracer.startActiveSpan("identity", (span) => {',
        '    try {',
        '      return value;',
        '    } finally {',
        '      span.end();',
        '    }',
        '  });',
        '}',
      ].join('\n');

      const results = checkExportedSignaturePreservationTs(original, instrumented, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('flags when instrumented code adds a span parameter to the signature', () => {
      const original = [
        'export function processItem(item: string): string {',
        '  return item.trim();',
        '}',
      ].join('\n');

      // Agent wrongly added span as a parameter
      const instrumented = [
        'export function processItem(item: string, span: any): string {',
        '  return item.trim();',
        '}',
      ].join('\n');

      const results = checkExportedSignaturePreservationTs(original, instrumented, filePath);
      expect(results.some(r => !r.passed)).toBe(true);
    });
  });

  describe('TypeScript class method signatures', () => {
    it('passes for class method with preserved TypeScript signature', () => {
      const original = [
        'export class UserService {',
        '  async getUser(id: string): Promise<string | null> {',
        '    return null;',
        '  }',
        '}',
      ].join('\n');

      // Class methods are not exported at the module level — NDS-004 checks module exports
      // This should pass since no exported functions are affected
      const instrumented = [
        "import { trace } from '@opentelemetry/api';",
        'export class UserService {',
        '  async getUser(id: string): Promise<string | null> {',
        '    return null;',
        '  }',
        '}',
      ].join('\n');

      const results = checkExportedSignaturePreservationTs(original, instrumented, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });
  });

  describe('no exported functions', () => {
    it('passes when no exported functions exist', () => {
      const original = 'const x: number = 42;';
      const instrumented = 'const x: number = 42;';

      const results = checkExportedSignaturePreservationTs(original, instrumented, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });
  });
});

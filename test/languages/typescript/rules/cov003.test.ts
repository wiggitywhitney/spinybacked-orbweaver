// ABOUTME: Tests for TypeScript COV-003 Tier 2 check — error visibility in spans.
// ABOUTME: Verifies error recording detection for TypeScript catch bindings including catch (err: unknown).

import { describe, it, expect } from 'vitest';
import { checkErrorVisibilityTs } from '../../../../src/languages/typescript/rules/cov003.ts';

describe('checkErrorVisibilityTs (COV-003 TypeScript)', () => {
  const filePath = '/tmp/test-file.ts';

  describe('applicableTo', () => {
    it('rule applies to TypeScript', async () => {
      const { cov003TsRule } = await import('../../../../src/languages/typescript/rules/cov003.ts');
      expect(cov003TsRule.applicableTo('typescript')).toBe(true);
    });

    it('rule does not apply to JavaScript', async () => {
      const { cov003TsRule } = await import('../../../../src/languages/typescript/rules/cov003.ts');
      expect(cov003TsRule.applicableTo('javascript')).toBe(false);
    });
  });

  describe('TypeScript catch binding with type annotation', () => {
    it('passes when catch (err: unknown) has error recording', () => {
      const code = [
        "import { trace, SpanStatusCode } from '@opentelemetry/api';",
        'const tracer = trace.getTracer("svc");',
        'export async function getUser(): Promise<string> {',
        '  return tracer.startActiveSpan("getUser", async (span) => {',
        '    try {',
        '      return "user";',
        '    } catch (err: unknown) {',
        '      span.recordException(err instanceof Error ? err : new Error(String(err)));',
        '      span.setStatus({ code: SpanStatusCode.ERROR });',
        '      throw err;',
        '    } finally {',
        '      span.end();',
        '    }',
        '  });',
        '}',
      ].join('\n');

      const results = checkErrorVisibilityTs(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('flags when catch (err: unknown) has no error recording', () => {
      const code = [
        "import { trace } from '@opentelemetry/api';",
        'const tracer = trace.getTracer("svc");',
        'export async function getUser(): Promise<string> {',
        '  return tracer.startActiveSpan("getUser", async (span) => {',
        '    try {',
        '      return "user";',
        '    } catch (err: unknown) {',
        '      throw err;',
        '    } finally {',
        '      span.end();',
        '    }',
        '  });',
        '}',
      ].join('\n');

      const results = checkErrorVisibilityTs(code, filePath);
      expect(results.some(r => !r.passed)).toBe(true);
      expect(results[0].ruleId).toBe('COV-003');
    });

    it('passes when catch (error: unknown) uses type narrowing before recording', () => {
      const code = [
        "import { trace, SpanStatusCode } from '@opentelemetry/api';",
        'const tracer = trace.getTracer("svc");',
        'export async function getUser(): Promise<string> {',
        '  return tracer.startActiveSpan("getUser", async (span) => {',
        '    try {',
        '      return "user";',
        '    } catch (error: unknown) {',
        '      span.recordException(error as Error);',
        '      span.setStatus({ code: SpanStatusCode.ERROR });',
        '      throw error;',
        '    } finally {',
        '      span.end();',
        '    }',
        '  });',
        '}',
      ].join('\n');

      const results = checkErrorVisibilityTs(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });
  });

  describe('TypeScript catch without type annotation (plain catch)', () => {
    it('flags when plain catch block has no error recording', () => {
      const code = [
        "import { trace } from '@opentelemetry/api';",
        'const tracer = trace.getTracer("svc");',
        'export async function getUser(): Promise<string> {',
        '  return tracer.startActiveSpan("getUser", async (span) => {',
        '    try {',
        '      return "user";',
        '    } catch (err) {',
        '      throw err;',
        '    } finally {',
        '      span.end();',
        '    }',
        '  });',
        '}',
      ].join('\n');

      const results = checkErrorVisibilityTs(code, filePath);
      expect(results.some(r => !r.passed)).toBe(true);
    });
  });

  describe('no spans', () => {
    it('passes when no spans exist in file', () => {
      const code = [
        'export async function getUser(): Promise<string> {',
        '  return "user";',
        '}',
      ].join('\n');

      const results = checkErrorVisibilityTs(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });
  });
});

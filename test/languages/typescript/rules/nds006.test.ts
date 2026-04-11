// ABOUTME: Tests for TypeScript NDS-006 Tier 2 check — module system preservation.
// ABOUTME: Verifies ESM/CJS detection works correctly for TypeScript files.

import { describe, it, expect } from 'vitest';
import { checkModuleSystemMatchTs } from '../../../../src/languages/typescript/rules/nds006.ts';

describe('checkModuleSystemMatchTs (NDS-006 TypeScript)', () => {
  const filePath = '/tmp/test-file.ts';

  describe('applicableTo', () => {
    it('rule applies to TypeScript', async () => {
      const { nds006TsRule } = await import('../../../../src/languages/typescript/rules/nds006.ts');
      expect(nds006TsRule.applicableTo('typescript')).toBe(true);
    });

    it('rule does not apply to JavaScript', async () => {
      const { nds006TsRule } = await import('../../../../src/languages/typescript/rules/nds006.ts');
      expect(nds006TsRule.applicableTo('javascript')).toBe(false);
    });
  });

  describe('TypeScript ESM stays ESM', () => {
    it('passes when TypeScript file adds OTel import (ESM stays ESM)', () => {
      const original = [
        "import { Pool } from 'pg';",
        "import type { Request, Response } from 'express';",
        'export async function getUsers(req: Request, res: Response): Promise<void> {',
        '  const pool = new Pool();',
        '  res.json(await pool.query("SELECT * FROM users"));',
        '}',
      ].join('\n');

      const instrumented = [
        "import { Pool } from 'pg';",
        "import type { Request, Response } from 'express';",
        "import { trace } from '@opentelemetry/api';",
        'const tracer = trace.getTracer("svc");',
        'export async function getUsers(req: Request, res: Response): Promise<void> {',
        '  return tracer.startActiveSpan("getUsers", async (span) => {',
        '    try {',
        '      const pool = new Pool();',
        '      res.json(await pool.query("SELECT * FROM users"));',
        '    } finally {',
        '      span.end();',
        '    }',
        '  });',
        '}',
      ].join('\n');

      const results = checkModuleSystemMatchTs(original, instrumented, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('flags when CJS require() is introduced into a TypeScript ESM file', () => {
      const original = [
        "import { trace } from '@opentelemetry/api';",
        'export function doWork(): void {}',
      ].join('\n');

      // Agent wrongly used require() instead of import
      const instrumented = [
        "import { trace } from '@opentelemetry/api';",
        "const otel = require('@opentelemetry/api');",
        'export function doWork(): void {}',
      ].join('\n');

      const results = checkModuleSystemMatchTs(original, instrumented, filePath);
      expect(results.some(r => !r.passed)).toBe(true);
      expect(results[0].ruleId).toBe('NDS-006');
    });
  });

  describe('TypeScript with import type (type erasure)', () => {
    it('passes when import type does not change module system classification', () => {
      const original = [
        "import type { UserDto } from './types';",
        "import { UserService } from './service';",
        'export async function getUser(id: string): Promise<UserDto | null> {',
        '  return new UserService().get(id);',
        '}',
      ].join('\n');

      const instrumented = [
        "import type { UserDto } from './types';",
        "import { UserService } from './service';",
        "import { trace } from '@opentelemetry/api';",
        'const tracer = trace.getTracer("svc");',
        'export async function getUser(id: string): Promise<UserDto | null> {',
        '  return tracer.startActiveSpan("getUser", async (span) => {',
        '    try {',
        '      return new UserService().get(id);',
        '    } finally {',
        '      span.end();',
        '    }',
        '  });',
        '}',
      ].join('\n');

      const results = checkModuleSystemMatchTs(original, instrumented, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });
  });

  describe('no module system signals', () => {
    it('passes when original has no module system signals (unknown)', () => {
      const original = 'const x: number = 42;';
      const instrumented = 'const x: number = 42;';

      const results = checkModuleSystemMatchTs(original, instrumented, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });
  });
});

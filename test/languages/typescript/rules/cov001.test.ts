// ABOUTME: Tests for TypeScript COV-001 Tier 2 check — entry points have spans.
// ABOUTME: Verifies NestJS decorator detection and Express/Fastify handlers in TypeScript.

import { describe, it, expect } from 'vitest';
import { checkEntryPointSpansTs } from '../../../../src/languages/typescript/rules/cov001.ts';

describe('checkEntryPointSpansTs (COV-001 TypeScript)', () => {
  const filePath = '/tmp/test-file.ts';

  describe('applicableTo', () => {
    it('rule applies to TypeScript', async () => {
      const { cov001TsRule } = await import('../../../../src/languages/typescript/rules/cov001.ts');
      expect(cov001TsRule.applicableTo('typescript')).toBe(true);
    });

    it('rule does not apply to JavaScript (TypeScript-specific implementation)', async () => {
      const { cov001TsRule } = await import('../../../../src/languages/typescript/rules/cov001.ts');
      expect(cov001TsRule.applicableTo('javascript')).toBe(false);
    });
  });

  describe('Express handlers with TypeScript annotations', () => {
    it('passes when Express handler has span (TypeScript code)', () => {
      const code = [
        "import { trace } from '@opentelemetry/api';",
        "import type { Request, Response } from 'express';",
        'const tracer = trace.getTracer("svc");',
        'app.get("/users", (req: Request, res: Response) => {',
        '  return tracer.startActiveSpan("GET /users", (span) => {',
        '    try {',
        '      res.json([]);',
        '    } finally {',
        '      span.end();',
        '    }',
        '  });',
        '});',
      ].join('\n');

      const results = checkEntryPointSpansTs(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('flags Express handler without span (TypeScript code)', () => {
      const code = [
        "import type { Request, Response } from 'express';",
        'app.get("/users", (req: Request, res: Response) => {',
        '  res.json([]);',
        '});',
      ].join('\n');

      const results = checkEntryPointSpansTs(code, filePath);
      expect(results.some(r => !r.passed)).toBe(true);
      expect(results[0].ruleId).toBe('COV-001');
    });
  });

  describe('NestJS controller class with decorators', () => {
    it('passes when NestJS controller method has span', () => {
      const code = [
        "import { Controller, Get } from '@nestjs/common';",
        "import { trace } from '@opentelemetry/api';",
        'const tracer = trace.getTracer("svc");',
        "@Controller('/users')",
        'class UserController {',
        '  @Get("/:id")',
        '  async getUser(): Promise<string> {',
        '    return tracer.startActiveSpan("getUser", async (span) => {',
        '      try {',
        '        return "user";',
        '      } finally {',
        '        span.end();',
        '      }',
        '    });',
        '  }',
        '}',
      ].join('\n');

      const results = checkEntryPointSpansTs(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('flags NestJS controller method without span', () => {
      const code = [
        "import { Controller, Get } from '@nestjs/common';",
        "@Controller('/users')",
        'class UserController {',
        '  @Get("/:id")',
        '  async getUser(): Promise<string> {',
        '    return "user";',
        '  }',
        '}',
      ].join('\n');

      const results = checkEntryPointSpansTs(code, filePath);
      expect(results.some(r => !r.passed)).toBe(true);
      expect(results[0].ruleId).toBe('COV-001');
    });

    it('flags NestJS Post method without span', () => {
      const code = [
        "import { Controller, Post, Body } from '@nestjs/common';",
        "@Controller('/users')",
        'class UserController {',
        '  @Post()',
        '  async createUser(@Body() body: { name: string }): Promise<void> {',
        '    await this.service.create(body);',
        '  }',
        '}',
      ].join('\n');

      const results = checkEntryPointSpansTs(code, filePath);
      expect(results.some(r => !r.passed)).toBe(true);
    });

    it('passes when class has no route decorators (not a controller)', () => {
      const code = [
        'class UserService {',
        '  async getUser(): Promise<string> {',
        '    return "user";',
        '  }',
        '}',
      ].join('\n');

      const results = checkEntryPointSpansTs(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });
  });

  describe('exported async functions with TypeScript annotations', () => {
    it('flags exported async handler in routes directory without span', () => {
      const routesFilePath = '/app/routes/users.ts';
      const code = [
        "import type { Request, Response } from 'express';",
        'export async function getUsers(req: Request, res: Response): Promise<void> {',
        '  res.json([]);',
        '}',
      ].join('\n');

      const results = checkEntryPointSpansTs(code, routesFilePath);
      expect(results.some(r => !r.passed)).toBe(true);
    });
  });

  describe('no entry points', () => {
    it('passes when no entry points exist', () => {
      const code = 'function helper(x: number): number {\n  return x + 1;\n}\n';
      const results = checkEntryPointSpansTs(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
      expect(results[0].ruleId).toBe('COV-001');
    });
  });
});

// ABOUTME: Cross-language rule consistency tests — verifies the same semantic violation is caught
// ABOUTME: by both the JavaScript and TypeScript checker implementations of shared-concept rules.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkEntryPointSpans } from '../../src/languages/javascript/rules/cov001.ts';
import { checkEntryPointSpansTs } from '../../src/languages/typescript/rules/cov001.ts';
import { checkErrorVisibility } from '../../src/languages/javascript/rules/cov003.ts';
import { checkErrorVisibilityTs } from '../../src/languages/typescript/rules/cov003.ts';
import { checkExportedSignaturePreservation } from '../../src/languages/javascript/rules/nds004.ts';
import { checkExportedSignaturePreservationTs } from '../../src/languages/typescript/rules/nds004.ts';
import { checkModuleSystemMatch } from '../../src/languages/javascript/rules/nds006.ts';
import { checkModuleSystemMatchTs } from '../../src/languages/typescript/rules/nds006.ts';

const FIXTURES_DIR = join(import.meta.dirname, '../fixtures/languages/javascript');

// ─────────────────────────────────────────────────────────────────────────────
// COV-001: Entry points have spans
// ─────────────────────────────────────────────────────────────────────────────

describe('COV-001: Entry points have spans', () => {
  it('catches missing span on JS Express handler (fixture: express-handler.before.js)', () => {
    const code = readFileSync(join(FIXTURES_DIR, 'express-handler.before.js'), 'utf-8');

    const results = checkEntryPointSpans(code, 'express-handler.js');
    const failures = results.filter(r => !r.passed);

    expect(failures.length).toBeGreaterThan(0);
    expect(failures[0].ruleId).toBe('COV-001');
    expect(failures[0].tier).toBe(2);
    expect(failures[0].blocking).toBe(true);
  });

  it('passes for JS Express handler with span (fixture: express-handler.after.js)', () => {
    const code = readFileSync(join(FIXTURES_DIR, 'express-handler.after.js'), 'utf-8');

    const results = checkEntryPointSpans(code, 'express-handler.js');
    expect(results.every(r => r.passed)).toBe(true);
  });

  it('catches missing span on JS Express handler (inline)', () => {
    const code = [
      'app.get("/users", (req, res) => {',
      '  res.json([]);',
      '});',
    ].join('\n');

    const results = checkEntryPointSpans(code, '/routes/users.js');
    const failures = results.filter(r => !r.passed);

    expect(failures.length).toBeGreaterThan(0);
    expect(failures[0].ruleId).toBe('COV-001');
    expect(failures[0].tier).toBe(2);
    expect(failures[0].blocking).toBe(true);
  });

  it('passes when JS Express handler has span', () => {
    const code = [
      'const { trace } = require("@opentelemetry/api");',
      'const tracer = trace.getTracer("svc");',
      'app.get("/users", (req, res) => {',
      '  return tracer.startActiveSpan("GET /users", (span) => {',
      '    try {',
      '      res.json([]);',
      '    } finally {',
      '      span.end();',
      '    }',
      '  });',
      '});',
    ].join('\n');

    const results = checkEntryPointSpans(code, '/routes/users.js');
    expect(results.every(r => r.passed)).toBe(true);
  });

  it('catches missing span on TS NestJS controller method', () => {
    const code = [
      "import { Controller, Get } from '@nestjs/common';",
      '@Controller("/users")',
      'export class UsersController {',
      '  @Get()',
      '  async getUsers(): Promise<string[]> {',
      '    return [];',
      '  }',
      '}',
    ].join('\n');

    const results = checkEntryPointSpansTs(code, '/controllers/users.controller.ts');
    const failures = results.filter(r => !r.passed);

    expect(failures.length).toBeGreaterThan(0);
    expect(failures[0].ruleId).toBe('COV-001');
    expect(failures[0].tier).toBe(2);
    expect(failures[0].blocking).toBe(true);
  });

  it('passes when TS NestJS controller method has span', () => {
    const code = [
      "import { trace } from '@opentelemetry/api';",
      "import { Controller, Get } from '@nestjs/common';",
      'const tracer = trace.getTracer("svc");',
      '@Controller("/users")',
      'export class UsersController {',
      '  @Get()',
      '  async getUsers(): Promise<string[]> {',
      '    return tracer.startActiveSpan("GET /users", async (span) => {',
      '      try {',
      '        return [];',
      '      } finally {',
      '        span.end();',
      '      }',
      '    });',
      '  }',
      '}',
    ].join('\n');

    const results = checkEntryPointSpansTs(code, '/controllers/users.controller.ts');
    expect(results.every(r => r.passed)).toBe(true);
  });

  // Python and Go cases added when those providers merge (PRD #373, PRD #374)
});

// ─────────────────────────────────────────────────────────────────────────────
// COV-003: Failable operations have error visibility
// ─────────────────────────────────────────────────────────────────────────────

describe('COV-003: Failable operations have error visibility', () => {
  it('catches missing error recording in JS catch block', () => {
    const code = [
      'const { trace } = require("@opentelemetry/api");',
      'const tracer = trace.getTracer("svc");',
      'tracer.startActiveSpan("fetchUser", (span) => {',
      '  try {',
      '    return db.find(userId);',
      '  } catch (err) {',
      '    // error not recorded on span',
      '    throw err;',
      '  } finally {',
      '    span.end();',
      '  }',
      '});',
    ].join('\n');

    const results = checkErrorVisibility(code, '/services/user.js');
    const failures = results.filter(r => !r.passed);

    expect(failures.length).toBeGreaterThan(0);
    expect(failures[0].ruleId).toBe('COV-003');
    expect(failures[0].tier).toBe(2);
    expect(failures[0].blocking).toBe(true);
  });

  it('passes when JS catch block records error on span', () => {
    const code = [
      'const { trace, SpanStatusCode } = require("@opentelemetry/api");',
      'const tracer = trace.getTracer("svc");',
      'tracer.startActiveSpan("fetchUser", (span) => {',
      '  try {',
      '    return db.find(userId);',
      '  } catch (err) {',
      '    span.recordException(err);',
      '    span.setStatus({ code: SpanStatusCode.ERROR });',
      '    throw err;',
      '  } finally {',
      '    span.end();',
      '  }',
      '});',
    ].join('\n');

    const results = checkErrorVisibility(code, '/services/user.js');
    expect(results.every(r => r.passed)).toBe(true);
  });

  it('catches missing error recording in TS catch block with unknown type annotation', () => {
    const code = [
      "import { trace } from '@opentelemetry/api';",
      'const tracer = trace.getTracer("svc");',
      'tracer.startActiveSpan("fetchUser", (span) => {',
      '  try {',
      '    return db.find(userId);',
      '  } catch (err: unknown) {',
      '    // TypeScript unknown catch type — error not recorded on span',
      '    throw err;',
      '  } finally {',
      '    span.end();',
      '  }',
      '});',
    ].join('\n');

    const results = checkErrorVisibilityTs(code, '/services/user.ts');
    const failures = results.filter(r => !r.passed);

    expect(failures.length).toBeGreaterThan(0);
    expect(failures[0].ruleId).toBe('COV-003');
    expect(failures[0].tier).toBe(2);
    expect(failures[0].blocking).toBe(true);
  });

  it('passes when TS catch block with unknown type records error on span', () => {
    const code = [
      "import { trace, SpanStatusCode } from '@opentelemetry/api';",
      'const tracer = trace.getTracer("svc");',
      'tracer.startActiveSpan("fetchUser", (span) => {',
      '  try {',
      '    return db.find(userId);',
      '  } catch (err: unknown) {',
      '    span.recordException(err as Error);',
      '    span.setStatus({ code: SpanStatusCode.ERROR });',
      '    throw err;',
      '  } finally {',
      '    span.end();',
      '  }',
      '});',
    ].join('\n');

    const results = checkErrorVisibilityTs(code, '/services/user.ts');
    expect(results.every(r => r.passed)).toBe(true);
  });

  // Python and Go cases added when those providers merge (PRD #373, PRD #374)
});

// ─────────────────────────────────────────────────────────────────────────────
// NDS-004: Exported function signatures preserved
// ─────────────────────────────────────────────────────────────────────────────

describe('NDS-004: Exported function signatures preserved', () => {
  it('flags signature change on JS exported function', () => {
    const original = [
      'export function getUser(id) {',
      '  return db.find(id);',
      '}',
    ].join('\n');

    const instrumented = [
      'export function getUser(id, span) {',
      '  return db.find(id);',
      '}',
    ].join('\n');

    const results = checkExportedSignaturePreservation(original, instrumented, '/services/user.js');
    const failures = results.filter(r => !r.passed);

    expect(failures.length).toBeGreaterThan(0);
    expect(failures[0].ruleId).toBe('NDS-004');
    expect(failures[0].tier).toBe(2);
  });

  it('passes when JS exported function signature is unchanged', () => {
    const original = 'export function getUser(id) { return db.find(id); }';
    const instrumented = [
      "import { trace } from '@opentelemetry/api';",
      'export function getUser(id) { return db.find(id); }',
    ].join('\n');

    const results = checkExportedSignaturePreservation(original, instrumented, '/services/user.js');
    expect(results.every(r => r.passed)).toBe(true);
  });

  it('flags signature change on TS exported function with type annotations', () => {
    const original = [
      "import type { Request, Response } from 'express';",
      'export async function handleRequest(req: Request, res: Response): Promise<void> {',
      '  res.json({});',
      '}',
    ].join('\n');

    // Agent incorrectly added a span parameter
    const instrumented = [
      "import { trace } from '@opentelemetry/api';",
      "import type { Request, Response, Span } from 'express';",
      'export async function handleRequest(req: Request, res: Response, span: Span): Promise<void> {',
      '  res.json({});',
      '}',
    ].join('\n');

    const results = checkExportedSignaturePreservationTs(original, instrumented, '/handlers/request.ts');
    const failures = results.filter(r => !r.passed);

    expect(failures.length).toBeGreaterThan(0);
    expect(failures[0].ruleId).toBe('NDS-004');
    expect(failures[0].tier).toBe(2);
  });

  it('passes when TS exported function preserves typed parameter names', () => {
    const original = [
      "import type { Request, Response } from 'express';",
      'export async function handleRequest(req: Request, res: Response): Promise<void> {',
      '  res.json({});',
      '}',
    ].join('\n');

    const instrumented = [
      "import { trace } from '@opentelemetry/api';",
      "import type { Request, Response } from 'express';",
      'const tracer = trace.getTracer("svc");',
      'export async function handleRequest(req: Request, res: Response): Promise<void> {',
      '  return tracer.startActiveSpan("handleRequest", async (span) => {',
      '    try {',
      '      res.json({});',
      '    } finally {',
      '      span.end();',
      '    }',
      '  });',
      '}',
    ].join('\n');

    const results = checkExportedSignaturePreservationTs(original, instrumented, '/handlers/request.ts');
    expect(results.every(r => r.passed)).toBe(true);
  });

  // Python and Go cases added when those providers merge (PRD #373, PRD #374)
});

// ─────────────────────────────────────────────────────────────────────────────
// NDS-006: Module system preserved
// ─────────────────────────────────────────────────────────────────────────────

describe('NDS-006: Module system preserved', () => {
  it('flags CJS require() introduced in JS ESM file', () => {
    const original = [
      "import express from 'express';",
      'export default function handler(req, res) {',
      '  res.json({});',
      '}',
    ].join('\n');

    // Agent incorrectly used require() for OTel import in an ESM file
    const instrumented = [
      "import express from 'express';",
      'const { trace } = require("@opentelemetry/api");',
      'export default function handler(req, res) {',
      '  res.json({});',
      '}',
    ].join('\n');

    const results = checkModuleSystemMatch(original, instrumented, '/handlers/handler.js');
    const failures = results.filter(r => !r.passed);

    expect(failures.length).toBeGreaterThan(0);
    expect(failures[0].ruleId).toBe('NDS-006');
    expect(failures[0].tier).toBe(2);
  });

  it('passes when JS ESM file stays ESM after instrumentation', () => {
    const original = [
      "import express from 'express';",
      'export default function handler(req, res) {',
      '  res.json({});',
      '}',
    ].join('\n');

    const instrumented = [
      "import express from 'express';",
      "import { trace } from '@opentelemetry/api';",
      'const tracer = trace.getTracer("svc");',
      'export default function handler(req, res) {',
      '  res.json({});',
      '}',
    ].join('\n');

    const results = checkModuleSystemMatch(original, instrumented, '/handlers/handler.js');
    expect(results.every(r => r.passed)).toBe(true);
  });

  it('flags CJS require() introduced in TS ESM file', () => {
    const original = [
      "import type { Request, Response } from 'express';",
      'export async function handleRequest(req: Request, res: Response): Promise<void> {',
      '  res.json({});',
      '}',
    ].join('\n');

    // Agent incorrectly used require() in a TypeScript ESM file
    const instrumented = [
      "import type { Request, Response } from 'express';",
      'const { trace } = require("@opentelemetry/api");',
      'export async function handleRequest(req: Request, res: Response): Promise<void> {',
      '  res.json({});',
      '}',
    ].join('\n');

    const results = checkModuleSystemMatchTs(original, instrumented, '/handlers/handler.ts');
    const failures = results.filter(r => !r.passed);

    expect(failures.length).toBeGreaterThan(0);
    expect(failures[0].ruleId).toBe('NDS-006');
    expect(failures[0].tier).toBe(2);
  });

  it('passes when TS ESM file stays ESM after instrumentation', () => {
    const original = [
      "import type { Request, Response } from 'express';",
      'export async function handleRequest(req: Request, res: Response): Promise<void> {',
      '  res.json({});',
      '}',
    ].join('\n');

    const instrumented = [
      "import { trace } from '@opentelemetry/api';",
      "import type { Request, Response } from 'express';",
      'const tracer = trace.getTracer("svc");',
      'export async function handleRequest(req: Request, res: Response): Promise<void> {',
      '  return tracer.startActiveSpan("handleRequest", async (span) => {',
      '    try {',
      '      res.json({});',
      '    } finally {',
      '      span.end();',
      '    }',
      '  });',
      '}',
    ].join('\n');

    const results = checkModuleSystemMatchTs(original, instrumented, '/handlers/handler.ts');
    expect(results.every(r => r.passed)).toBe(true);
  });

  // Python and Go cases added when those providers merge (PRD #373, PRD #374)
});

// ABOUTME: Cross-language rule consistency tests — verifies the same semantic violation is caught
// ABOUTME: by both the JavaScript and TypeScript checker implementations of shared-concept rules.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkEntryPointSpans } from '../../src/languages/javascript/rules/cov001.ts';
import { checkEntryPointSpansTs } from '../../src/languages/typescript/rules/cov001.ts';
import { checkPythonEntryPointSpans } from '../../src/languages/python/rules/cov001.ts';
import { checkOutboundCallSpans } from '../../src/languages/javascript/rules/cov002.ts';
import { checkPythonOutboundCallSpans } from '../../src/languages/python/rules/cov002.ts';
import { checkErrorVisibility } from '../../src/languages/javascript/rules/cov003.ts';
import { checkErrorVisibilityTs } from '../../src/languages/typescript/rules/cov003.ts';
import { checkPythonErrorVisibility } from '../../src/languages/python/rules/cov003.ts';
import { checkAsyncOperationSpans } from '../../src/languages/javascript/rules/cov004.ts';
import { checkPythonAsyncOperationSpans } from '../../src/languages/python/rules/cov004.ts';
import { checkAutoInstrumentationPreference } from '../../src/languages/javascript/rules/cov006.ts';
import { checkPythonAutoInstrumentationPreference } from '../../src/languages/python/rules/cov006.ts';
import { checkExportedSignaturePreservation } from '../../src/languages/javascript/rules/nds004.ts';
import { checkExportedSignaturePreservationTs } from '../../src/languages/typescript/rules/nds004.ts';
import { checkPythonSignaturePreservation } from '../../src/languages/python/rules/nds004.ts';
import { checkModuleSystemMatch } from '../../src/languages/javascript/rules/nds006.ts';
import { checkModuleSystemMatchTs } from '../../src/languages/typescript/rules/nds006.ts';
import { checkSpansClosed } from '../../src/languages/javascript/rules/cdq001.ts';
import { checkPythonSpansClosed } from '../../src/languages/python/rules/cdq001.ts';
import { checkUtilityFunctionSpans } from '../../src/languages/javascript/rules/rst001.ts';
import { checkPythonUtilityFunctionSpans } from '../../src/languages/python/rules/rst001.ts';

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

  it('catches missing span on Python Flask route handler', () => {
    const code = [
      '@app.route("/users")',
      'def list_users():',
      '    return jsonify([])',
      '',
    ].join('\n');

    const results = checkPythonEntryPointSpans(code, '/routes/users.py');
    const failures = results.filter(r => !r.passed);

    expect(failures.length).toBeGreaterThan(0);
    expect(failures[0].ruleId).toBe('COV-001');
    expect(failures[0].tier).toBe(2);
    expect(failures[0].blocking).toBe(true);
  });

  it('passes when Python Flask route handler has span', () => {
    const code = [
      'from opentelemetry import trace',
      'tracer = trace.get_tracer("svc")',
      '',
      '@app.route("/users")',
      'def list_users():',
      '    with tracer.start_as_current_span("list_users"):',
      '        return jsonify([])',
      '',
    ].join('\n');

    const results = checkPythonEntryPointSpans(code, '/routes/users.py');
    expect(results.every(r => r.passed)).toBe(true);
  });

  // Go cases added when that provider merges (PRD #374)
});

// ─────────────────────────────────────────────────────────────────────────────
// COV-002: Outbound calls have spans
// ─────────────────────────────────────────────────────────────────────────────

describe('COV-002: Outbound calls have spans', () => {
  it('catches missing span on JS outbound fetch() call', () => {
    const code = [
      'async function getData() {',
      '  const res = await fetch("https://api.example.com/data");',
      '  return await res.json();',
      '}',
    ].join('\n');

    const results = checkOutboundCallSpans(code, '/services/data.js');
    const failures = results.filter(r => !r.passed);

    expect(failures.length).toBeGreaterThan(0);
    expect(failures[0].ruleId).toBe('COV-002');
    expect(failures[0].tier).toBe(2);
    expect(failures[0].blocking).toBe(true);
  });

  it('passes when JS outbound fetch() call is inside a span', () => {
    const code = [
      'const { trace } = require("@opentelemetry/api");',
      'const tracer = trace.getTracer("svc");',
      'async function getData() {',
      '  return tracer.startActiveSpan("getData", async (span) => {',
      '    try {',
      '      const res = await fetch("https://api.example.com/data");',
      '      return await res.json();',
      '    } finally {',
      '      span.end();',
      '    }',
      '  });',
      '}',
    ].join('\n');

    const results = checkOutboundCallSpans(code, '/services/data.js');
    expect(results.every(r => r.passed)).toBe(true);
  });

  it('catches missing span on Python outbound requests.get() call', () => {
    const code = [
      'def fetch_user(user_id):',
      '    return requests.get(f"https://api.example.com/users/{user_id}")',
      '',
    ].join('\n');

    const results = checkPythonOutboundCallSpans(code, '/services/user.py');
    const failures = results.filter(r => !r.passed);

    expect(failures.length).toBeGreaterThan(0);
    expect(failures[0].ruleId).toBe('COV-002');
    expect(failures[0].tier).toBe(2);
    expect(failures[0].blocking).toBe(true);
  });

  it('passes when Python outbound requests.get() call is inside a `with` span', () => {
    const code = [
      'from opentelemetry import trace',
      'tracer = trace.get_tracer("svc")',
      '',
      'def fetch_user(user_id):',
      '    with tracer.start_as_current_span("fetch_user"):',
      '        return requests.get(f"https://api.example.com/users/{user_id}")',
      '',
    ].join('\n');

    const results = checkPythonOutboundCallSpans(code, '/services/user.py');
    expect(results.every(r => r.passed)).toBe(true);
  });

  // Go cases added when that provider merges (PRD #374)
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

  it('catches a swallowed exception in a Python except block with no error recording', () => {
    // Per OD-4's 2026-09-18 correction, Python's checker only flags a
    // *swallowed* exception (no re-raise) — a re-raising except block is
    // already covered by start_as_current_span()'s automatic recording,
    // unlike JavaScript's startActiveSpan(), which has no such default.
    const code = [
      'from opentelemetry import trace',
      'tracer = trace.get_tracer("svc")',
      '',
      'def fetch_user(user_id):',
      '    with tracer.start_as_current_span("fetch_user") as span:',
      '        try:',
      '            return db.find(user_id)',
      '        except LookupError as e:',
      '            return None',
      '',
    ].join('\n');

    const results = checkPythonErrorVisibility(code, '/services/user.py');
    const failures = results.filter(r => !r.passed);

    expect(failures.length).toBeGreaterThan(0);
    expect(failures[0].ruleId).toBe('COV-003');
    expect(failures[0].tier).toBe(2);
    expect(failures[0].blocking).toBe(true);
  });

  it('passes when a swallowed Python except block records the error on the span', () => {
    const code = [
      'from opentelemetry import trace',
      'tracer = trace.get_tracer("svc")',
      '',
      'def fetch_user(user_id):',
      '    with tracer.start_as_current_span("fetch_user") as span:',
      '        try:',
      '            return db.find(user_id)',
      '        except LookupError as e:',
      '            span.record_exception(e)',
      '            span.set_status(trace.Status(trace.StatusCode.ERROR, str(e)))',
      '            return None',
      '',
    ].join('\n');

    const results = checkPythonErrorVisibility(code, '/services/user.py');
    expect(results.every(r => r.passed)).toBe(true);
  });

  // Go cases added when that provider merges (PRD #374)
});

// ─────────────────────────────────────────────────────────────────────────────
// COV-004: Async operations have spans
// ─────────────────────────────────────────────────────────────────────────────

describe('COV-004: Async operations have spans', () => {
  it('catches missing span on a JS async function', () => {
    const code = [
      'async function fetchUser(userId) {',
      '  return await db.find(userId);',
      '}',
    ].join('\n');

    const results = checkAsyncOperationSpans(code, '/services/user.js');
    const failures = results.filter(r => !r.passed);

    expect(failures.length).toBeGreaterThan(0);
    expect(failures[0].ruleId).toBe('COV-004');
    expect(failures[0].tier).toBe(2);
    expect(failures[0].blocking).toBe(false);
  });

  it('passes when a JS async function has a span', () => {
    const code = [
      'const { trace } = require("@opentelemetry/api");',
      'const tracer = trace.getTracer("svc");',
      'async function fetchUser(userId) {',
      '  return tracer.startActiveSpan("fetchUser", async (span) => {',
      '    try {',
      '      return await db.find(userId);',
      '    } finally {',
      '      span.end();',
      '    }',
      '  });',
      '}',
    ].join('\n');

    const results = checkAsyncOperationSpans(code, '/services/user.js');
    expect(results.every(r => r.passed)).toBe(true);
  });

  it('catches a missing span on a Python async def function', () => {
    const code = [
      'async def fetch_user(user_id):',
      '    return await db.find(user_id)',
      '',
    ].join('\n');

    const results = checkPythonAsyncOperationSpans(code, '/services/user.py');
    const failures = results.filter(r => !r.passed);

    expect(failures.length).toBeGreaterThan(0);
    expect(failures[0].ruleId).toBe('COV-004');
    expect(failures[0].tier).toBe(2);
    expect(failures[0].blocking).toBe(false);
  });

  it('passes when a Python async def function has a span', () => {
    const code = [
      'from opentelemetry import trace',
      'tracer = trace.get_tracer("svc")',
      '',
      'async def fetch_user(user_id):',
      '    with tracer.start_as_current_span("fetch_user") as span:',
      '        return await db.find(user_id)',
      '',
    ].join('\n');

    const results = checkPythonAsyncOperationSpans(code, '/services/user.py');
    expect(results.every(r => r.passed)).toBe(true);
  });

  // Go cases added when that provider merges (PRD #374)
});

// ─────────────────────────────────────────────────────────────────────────────
// COV-006: Auto-instrumentation preferred over manual spans
// ─────────────────────────────────────────────────────────────────────────────

describe('COV-006: Auto-instrumentation preferred over manual spans', () => {
  it('catches a manual span wrapping only an outbound http call in JS', () => {
    const code = [
      'function fetchUser(userId) {',
      '  return tracer.startActiveSpan("fetchUser", (span) => {',
      '    return https.get(`https://api.example.com/users/${userId}`);',
      '  });',
      '}',
    ].join('\n');

    const results = checkAutoInstrumentationPreference(code, '/services/user.js');
    const failures = results.filter(r => !r.passed);

    expect(failures.length).toBeGreaterThan(0);
    expect(failures[0].ruleId).toBe('COV-006');
    expect(failures[0].tier).toBe(2);
  });

  it('passes when a JS span does more than wrap the outbound call', () => {
    const code = [
      'function fetchUser(userId) {',
      '  return tracer.startActiveSpan("fetchUser", (span) => {',
      '    const result = https.get(`https://api.example.com/users/${userId}`);',
      '    logger.info("fetched user", userId);',
      '    return result;',
      '  });',
      '}',
    ].join('\n');

    const results = checkAutoInstrumentationPreference(code, '/services/user.js');
    expect(results.every(r => r.passed)).toBe(true);
  });

  it('catches a manual span wrapping only a requests.get() call in Python', () => {
    const code = [
      'from opentelemetry import trace',
      'tracer = trace.get_tracer("svc")',
      '',
      'def fetch_user(user_id):',
      '    with tracer.start_as_current_span("fetch_user"):',
      '        return requests.get(f"https://api.example.com/users/{user_id}")',
      '',
    ].join('\n');

    const results = checkPythonAutoInstrumentationPreference(code, '/services/user.py');
    const failures = results.filter(r => !r.passed);

    expect(failures.length).toBeGreaterThan(0);
    expect(failures[0].ruleId).toBe('COV-006');
    expect(failures[0].tier).toBe(2);
  });

  it('passes when a Python span does more than wrap the requests.get() call', () => {
    const code = [
      'from opentelemetry import trace',
      'tracer = trace.get_tracer("svc")',
      '',
      'def fetch_user(user_id):',
      '    with tracer.start_as_current_span("fetch_user"):',
      '        resp = requests.get(f"https://api.example.com/users/{user_id}")',
      '        log.info("fetched user %s", user_id)',
      '        return resp',
      '',
    ].join('\n');

    const results = checkPythonAutoInstrumentationPreference(code, '/services/user.py');
    expect(results.every(r => r.passed)).toBe(true);
  });

  // Go cases added when that provider merges (PRD #374) — per OD-5, COV-006 is
  // applicableTo('go') = false, so no Go case applies here.
});

// ─────────────────────────────────────────────────────────────────────────────
// CDQ-001: Spans closed in all code paths
// ─────────────────────────────────────────────────────────────────────────────

describe('CDQ-001: Spans closed in all code paths', () => {
  it('catches a raw startSpan() in JS with no span.end() in finally', () => {
    const code = [
      'const { trace } = require("@opentelemetry/api");',
      'const tracer = trace.getTracer("svc");',
      'function doWork() {',
      '  const span = tracer.startSpan("doWork");',
      '  return computeResult();',
      '}',
    ].join('\n');

    const results = checkSpansClosed(code, '/services/work.js');
    const failures = results.filter(r => !r.passed);

    expect(failures.length).toBeGreaterThan(0);
    expect(failures[0].ruleId).toBe('CDQ-001');
    expect(failures[0].tier).toBe(2);
    expect(failures[0].blocking).toBe(true);
  });

  it('passes when a JS raw startSpan() has span.end() in a sibling finally', () => {
    const code = [
      'const { trace } = require("@opentelemetry/api");',
      'const tracer = trace.getTracer("svc");',
      'function doWork() {',
      '  const span = tracer.startSpan("doWork");',
      '  try {',
      '    return computeResult();',
      '  } finally {',
      '    span.end();',
      '  }',
      '}',
    ].join('\n');

    const results = checkSpansClosed(code, '/services/work.js');
    expect(results.every(r => r.passed)).toBe(true);
  });

  it('catches a raw start_span() in Python with no span.end() in finally', () => {
    const code = [
      'def do_work():',
      '    span = tracer.start_span("doWork")',
      '    return compute_result()',
      '',
    ].join('\n');

    const results = checkPythonSpansClosed(code, '/services/work.py');
    const failures = results.filter(r => !r.passed);

    expect(failures.length).toBeGreaterThan(0);
    expect(failures[0].ruleId).toBe('CDQ-001');
    expect(failures[0].tier).toBe(2);
    expect(failures[0].blocking).toBe(true);
  });

  it('passes when a Python raw start_span() has span.end() in a sibling finally', () => {
    const code = [
      'def do_work():',
      '    span = tracer.start_span("doWork")',
      '    try:',
      '        return compute_result()',
      '    finally:',
      '        span.end()',
      '',
    ].join('\n');

    const results = checkPythonSpansClosed(code, '/services/work.py');
    expect(results.every(r => r.passed)).toBe(true);
  });

  it('passes when a Python start_as_current_span() is used as a with block (no raw start_span involved)', () => {
    const code = [
      'def do_work():',
      '    with tracer.start_as_current_span("doWork") as span:',
      '        return compute_result()',
      '',
    ].join('\n');

    const results = checkPythonSpansClosed(code, '/services/work.py');
    expect(results.every(r => r.passed)).toBe(true);
  });

  // Go cases added when that provider merges (PRD #374)
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
      "import type { Request, Response } from 'express';",
      "import type { Span } from '@opentelemetry/api';",
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

  it('flags signature change on Python exported function', () => {
    const original = [
      'def get_user(user_id):',
      '    return db.find(user_id)',
      '',
    ].join('\n');

    const instrumented = [
      'def get_user(user_id, span):',
      '    return db.find(user_id)',
      '',
    ].join('\n');

    const results = checkPythonSignaturePreservation(original, instrumented, '/services/user.py');
    const failures = results.filter(r => !r.passed);

    expect(failures.length).toBeGreaterThan(0);
    expect(failures[0].ruleId).toBe('NDS-004');
    expect(failures[0].tier).toBe(2);
  });

  it('passes when Python exported function signature is unchanged', () => {
    const original = 'def get_user(user_id):\n    return db.find(user_id)\n';
    const instrumented = [
      'from opentelemetry import trace',
      'tracer = trace.get_tracer("svc")',
      '',
      'def get_user(user_id):',
      '    with tracer.start_as_current_span("get_user") as span:',
      '        return db.find(user_id)',
      '',
    ].join('\n');

    const results = checkPythonSignaturePreservation(original, instrumented, '/services/user.py');
    expect(results.every(r => r.passed)).toBe(true);
  });

  // Go cases added when that provider merges (PRD #374)
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

// ─────────────────────────────────────────────────────────────────────────────
// RST-001: No spans on utility functions
// ─────────────────────────────────────────────────────────────────────────────

describe('RST-001: No spans on utility functions', () => {
  it('flags a span on a short, unexported JS utility function', () => {
    const code = [
      'function _add(x, y) {',
      '  return tracer.startActiveSpan("_add", (span) => {',
      '    try {',
      '      return x + y;',
      '    } finally {',
      '      span.end();',
      '    }',
      '  });',
      '}',
    ].join('\n');

    const results = checkUtilityFunctionSpans(code, '/services/math.js');
    const failures = results.filter(r => !r.passed);

    expect(failures.length).toBeGreaterThan(0);
    expect(failures[0].ruleId).toBe('RST-001');
    expect(failures[0].tier).toBe(2);
    expect(failures[0].blocking).toBe(false);
  });

  it('passes when a JS utility function has no span', () => {
    const code = [
      'function _add(x, y) {',
      '  return x + y;',
      '}',
    ].join('\n');

    const results = checkUtilityFunctionSpans(code, '/services/math.js');
    expect(results.every(r => r.passed)).toBe(true);
  });

  it('flags a span on a short, unexported Python utility function', () => {
    const code = [
      'def _add(x, y):',
      '    with tracer.start_as_current_span("_add"):',
      '        return x + y',
      '',
    ].join('\n');

    const results = checkPythonUtilityFunctionSpans(code, '/services/math.py');
    const failures = results.filter(r => !r.passed);

    expect(failures.length).toBeGreaterThan(0);
    expect(failures[0].ruleId).toBe('RST-001');
    expect(failures[0].tier).toBe(2);
    expect(failures[0].blocking).toBe(false);
  });

  it('passes when a Python utility function has no span', () => {
    const code = [
      'def _add(x, y):',
      '    return x + y',
      '',
    ].join('\n');

    const results = checkPythonUtilityFunctionSpans(code, '/services/math.py');
    expect(results.every(r => r.passed)).toBe(true);
  });

  // Go cases added when that provider merges (PRD #374)
});

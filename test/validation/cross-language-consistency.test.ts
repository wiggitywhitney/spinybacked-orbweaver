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
import { checkTrivialAccessorSpans } from '../../src/languages/javascript/rules/rst002.ts';
import { checkPythonTrivialAccessorSpans } from '../../src/languages/python/rules/rst002.ts';
import { checkThinWrapperSpans } from '../../src/languages/javascript/rules/rst003.ts';
import { checkPythonThinWrapperSpans } from '../../src/languages/python/rules/rst003.ts';
import { checkInternalDetailSpans } from '../../src/languages/javascript/rules/rst004.ts';
import { checkPythonInternalDetailSpans } from '../../src/languages/python/rules/rst004.ts';
import { checkDoubleInstrumentation } from '../../src/languages/javascript/rules/rst005.ts';
import { checkPythonDoubleInstrumentation } from '../../src/languages/python/rules/rst005.ts';
import { checkProcessExitSpan } from '../../src/languages/javascript/rules/rst006.ts';
import { checkPythonProcessExitSpan } from '../../src/languages/python/rules/rst006.ts';
import { checkControlFlowPreservation } from '../../src/languages/javascript/rules/nds005.ts';
import { checkPythonControlFlowPreservation } from '../../src/languages/python/rules/nds005.ts';
import { checkNoErrorRecordingInExpectedConditionCatches } from '../../src/languages/javascript/rules/nds007.ts';
import { checkPythonNoErrorRecordingInExpectedConditionExcepts } from '../../src/languages/python/rules/nds007.ts';
import { checkStartActiveSpanPreferred } from '../../src/languages/javascript/rules/cdq005.ts';
import { checkPythonStartActiveSpanPreferred } from '../../src/languages/python/rules/cdq005.ts';
import { checkIsRecordingGuard } from '../../src/languages/javascript/rules/cdq006.ts';
import { checkPythonIsRecordingGuard } from '../../src/languages/python/rules/cdq006.ts';

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

// ─────────────────────────────────────────────────────────────────────────────
// RST-002: No spans on trivial accessors
// ─────────────────────────────────────────────────────────────────────────────

describe('RST-002: No spans on trivial accessors', () => {
  it('flags a span on a trivial JS get accessor', () => {
    const code = [
      'class Widget {',
      '  get name() {',
      '    return tracer.startActiveSpan("name", (span) => {',
      '      try {',
      '        return this._name;',
      '      } finally {',
      '        span.end();',
      '      }',
      '    });',
      '  }',
      '}',
    ].join('\n');

    const results = checkTrivialAccessorSpans(code, '/services/widget.js');
    const failures = results.filter(r => !r.passed);

    expect(failures.length).toBeGreaterThan(0);
    expect(failures[0].ruleId).toBe('RST-002');
    expect(failures[0].tier).toBe(2);
    expect(failures[0].blocking).toBe(false);
  });

  it('passes when a JS get accessor has no span', () => {
    const code = [
      'class Widget {',
      '  get name() {',
      '    return this._name;',
      '  }',
      '}',
    ].join('\n');

    const results = checkTrivialAccessorSpans(code, '/services/widget.js');
    expect(results.every(r => r.passed)).toBe(true);
  });

  it('flags a span on a trivial Python @property getter', () => {
    const code = [
      'class Widget:',
      '    @property',
      '    def name(self):',
      '        with tracer.start_as_current_span("name"):',
      '            return self._name',
      '',
    ].join('\n');

    const results = checkPythonTrivialAccessorSpans(code, '/services/widget.py');
    const failures = results.filter(r => !r.passed);

    expect(failures.length).toBeGreaterThan(0);
    expect(failures[0].ruleId).toBe('RST-002');
    expect(failures[0].tier).toBe(2);
    expect(failures[0].blocking).toBe(false);
  });

  it('passes when a Python @property getter has no span', () => {
    const code = [
      'class Widget:',
      '    @property',
      '    def name(self):',
      '        return self._name',
      '',
    ].join('\n');

    const results = checkPythonTrivialAccessorSpans(code, '/services/widget.py');
    expect(results.every(r => r.passed)).toBe(true);
  });

  // Go cases added when that provider merges (PRD #374)
});

// ─────────────────────────────────────────────────────────────────────────────
// RST-003: No duplicate spans on thin wrappers
// ─────────────────────────────────────────────────────────────────────────────

describe('RST-003: No duplicate spans on thin wrappers', () => {
  it('flags a span on a JS thin wrapper delegating to a same-file function', () => {
    const code = [
      'function realCompute(x) {',
      '  return x + 1;',
      '}',
      '',
      'function compute(x) {',
      '  return tracer.startActiveSpan("compute", (span) => {',
      '    try {',
      '      return realCompute(x);',
      '    } finally {',
      '      span.end();',
      '    }',
      '  });',
      '}',
    ].join('\n');

    const results = checkThinWrapperSpans(code, '/services/math.js');
    const failures = results.filter(r => !r.passed);

    expect(failures.length).toBeGreaterThan(0);
    expect(failures[0].ruleId).toBe('RST-003');
    expect(failures[0].tier).toBe(2);
    expect(failures[0].blocking).toBe(false);
  });

  it('passes when a JS thin wrapper has no span', () => {
    const code = [
      'function realCompute(x) {',
      '  return x + 1;',
      '}',
      '',
      'function compute(x) {',
      '  return realCompute(x);',
      '}',
    ].join('\n');

    const results = checkThinWrapperSpans(code, '/services/math.js');
    expect(results.every(r => r.passed)).toBe(true);
  });

  it('flags a span on a Python thin wrapper delegating to a same-file function', () => {
    const code = [
      'def _real_compute(x):',
      '    return x + 1',
      '',
      'def compute(x):',
      '    with tracer.start_as_current_span("compute"):',
      '        return _real_compute(x)',
      '',
    ].join('\n');

    const results = checkPythonThinWrapperSpans(code, '/services/math.py');
    const failures = results.filter(r => !r.passed);

    expect(failures.length).toBeGreaterThan(0);
    expect(failures[0].ruleId).toBe('RST-003');
    expect(failures[0].tier).toBe(2);
    expect(failures[0].blocking).toBe(false);
  });

  it('passes when a Python thin wrapper has no span', () => {
    const code = [
      'def _real_compute(x):',
      '    return x + 1',
      '',
      'def compute(x):',
      '    return _real_compute(x)',
      '',
    ].join('\n');

    const results = checkPythonThinWrapperSpans(code, '/services/math.py');
    expect(results.every(r => r.passed)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// RST-004: No spans on internal implementation details
// ─────────────────────────────────────────────────────────────────────────────

describe('RST-004: No spans on internal implementation details', () => {
  it('flags a span on an unexported JS function with no I/O', () => {
    const code = [
      'function helper(x) {',
      '  return tracer.startActiveSpan("helper", (span) => {',
      '    try {',
      '      return x + 1;',
      '    } finally {',
      '      span.end();',
      '    }',
      '  });',
      '}',
    ].join('\n');

    const results = checkInternalDetailSpans(code, '/services/math.js');
    const failures = results.filter(r => !r.passed);

    expect(failures.length).toBeGreaterThan(0);
    expect(failures[0].ruleId).toBe('RST-004');
    expect(failures[0].tier).toBe(2);
    expect(failures[0].blocking).toBe(false);
  });

  it('passes when an unexported JS function has no span', () => {
    const code = [
      'function helper(x) {',
      '  return x + 1;',
      '}',
    ].join('\n');

    const results = checkInternalDetailSpans(code, '/services/math.js');
    expect(results.every(r => r.passed)).toBe(true);
  });

  it('flags a span on an unexported Python function with no I/O', () => {
    const code = [
      'def _helper(x):',
      '    with tracer.start_as_current_span("_helper"):',
      '        return x + 1',
      '',
    ].join('\n');

    const results = checkPythonInternalDetailSpans(code, '/services/math.py');
    const failures = results.filter(r => !r.passed);

    expect(failures.length).toBeGreaterThan(0);
    expect(failures[0].ruleId).toBe('RST-004');
    expect(failures[0].tier).toBe(2);
    expect(failures[0].blocking).toBe(false);
  });

  it('passes when an unexported Python function has no span', () => {
    const code = [
      'def _helper(x):',
      '    return x + 1',
      '',
    ].join('\n');

    const results = checkPythonInternalDetailSpans(code, '/services/math.py');
    expect(results.every(r => r.passed)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// RST-005: No double-instrumentation
// ─────────────────────────────────────────────────────────────────────────────

describe('RST-005: No double-instrumentation', () => {
  it('flags a JS function that already had a span and gained another', () => {
    const original = [
      'function handler(x) {',
      '  return tracer.startActiveSpan("handler", (span) => {',
      '    try {',
      '      return x + 1;',
      '    } finally {',
      '      span.end();',
      '    }',
      '  });',
      '}',
    ].join('\n');
    const instrumented = [
      'function handler(x) {',
      '  return tracer.startActiveSpan("handler", (span) => {',
      '    try {',
      '      return tracer.startActiveSpan("handler-inner", (innerSpan) => {',
      '        try {',
      '          return x + 1;',
      '        } finally {',
      '          innerSpan.end();',
      '        }',
      '      });',
      '    } finally {',
      '      span.end();',
      '    }',
      '  });',
      '}',
    ].join('\n');

    const results = checkDoubleInstrumentation(original, instrumented, '/services/handler.js');
    const failures = results.filter(r => !r.passed);

    expect(failures.length).toBeGreaterThan(0);
    expect(failures[0].ruleId).toBe('RST-005');
    expect(failures[0].tier).toBe(2);
    expect(failures[0].blocking).toBe(false);
  });

  it('passes when a JS spanned function is left unchanged', () => {
    const code = [
      'function handler(x) {',
      '  return tracer.startActiveSpan("handler", (span) => {',
      '    try {',
      '      return x + 1;',
      '    } finally {',
      '      span.end();',
      '    }',
      '  });',
      '}',
    ].join('\n');

    const results = checkDoubleInstrumentation(code, code, '/services/handler.js');
    expect(results.every(r => r.passed)).toBe(true);
  });

  it('flags a Python function that already had a span and gained another', () => {
    const original = [
      'def handler(x):',
      '    with tracer.start_as_current_span("handler"):',
      '        return x + 1',
      '',
    ].join('\n');
    const instrumented = [
      'def handler(x):',
      '    with tracer.start_as_current_span("handler"):',
      '        with tracer.start_as_current_span("handler-inner"):',
      '            return x + 1',
      '',
    ].join('\n');

    const results = checkPythonDoubleInstrumentation(original, instrumented, '/services/handler.py');
    const failures = results.filter(r => !r.passed);

    expect(failures.length).toBeGreaterThan(0);
    expect(failures[0].ruleId).toBe('RST-005');
    expect(failures[0].tier).toBe(2);
    expect(failures[0].blocking).toBe(false);
  });

  it('passes when a Python spanned function is left unchanged', () => {
    const code = [
      'def handler(x):',
      '    with tracer.start_as_current_span("handler"):',
      '        return x + 1',
      '',
    ].join('\n');

    const results = checkPythonDoubleInstrumentation(code, code, '/services/handler.py');
    expect(results.every(r => r.passed)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// RST-006: No agent-added spans on process-exit-adjacent functions
// ─────────────────────────────────────────────────────────────────────────────

describe('RST-006: No agent-added spans on process-exit-adjacent functions', () => {
  it('flags a newly spanned JS function that calls process.exit() at its own top level', () => {
    const original = [
      'function fail(msg) {',
      '  if (msg) {',
      '    process.exit(1);',
      '  }',
      '  return doWork();',
      '}',
    ].join('\n');
    const instrumented = [
      'function fail(msg) {',
      '  if (msg) {',
      '    process.exit(1);',
      '  }',
      '  return tracer.startActiveSpan("fail", (span) => {',
      '    try {',
      '      return doWork();',
      '    } finally {',
      '      span.end();',
      '    }',
      '  });',
      '}',
    ].join('\n');

    const results = checkProcessExitSpan(original, instrumented, '/services/cli.js');
    const failures = results.filter(r => !r.passed);

    expect(failures.length).toBeGreaterThan(0);
    expect(failures[0].ruleId).toBe('RST-006');
    expect(failures[0].tier).toBe(2);
    expect(failures[0].blocking).toBe(false);
  });

  it('passes when a newly spanned JS function has no process.exit() call', () => {
    const original = [
      'function compute(x) {',
      '  return x + 1;',
      '}',
    ].join('\n');
    const instrumented = [
      'function compute(x) {',
      '  return tracer.startActiveSpan("compute", (span) => {',
      '    try {',
      '      return x + 1;',
      '    } finally {',
      '      span.end();',
      '    }',
      '  });',
      '}',
    ].join('\n');

    const results = checkProcessExitSpan(original, instrumented, '/services/cli.js');
    expect(results.every(r => r.passed)).toBe(true);
  });

  it('flags a newly spanned Python function that calls sys.exit()', () => {
    const original = [
      'def fail(msg):',
      '    print(msg)',
      '    sys.exit(1)',
      '',
    ].join('\n');
    const instrumented = [
      'def fail(msg):',
      '    with tracer.start_as_current_span("fail"):',
      '        print(msg)',
      '        sys.exit(1)',
      '',
    ].join('\n');

    const results = checkPythonProcessExitSpan(original, instrumented, '/services/cli.py');
    const failures = results.filter(r => !r.passed);

    expect(failures.length).toBeGreaterThan(0);
    expect(failures[0].ruleId).toBe('RST-006');
    expect(failures[0].tier).toBe(2);
    expect(failures[0].blocking).toBe(false);
  });

  it('passes when a newly spanned Python function has no sys.exit()/os._exit() call', () => {
    const original = [
      'def compute(x):',
      '    return x + 1',
      '',
    ].join('\n');
    const instrumented = [
      'def compute(x):',
      '    with tracer.start_as_current_span("compute"):',
      '        return x + 1',
      '',
    ].join('\n');

    const results = checkPythonProcessExitSpan(original, instrumented, '/services/cli.py');
    expect(results.every(r => r.passed)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// NDS-005: Control flow preservation
// ─────────────────────────────────────────────────────────────────────────────

describe('NDS-005: Control flow preservation', () => {
  it('flags a JS try/catch block entirely removed from the instrumented output', () => {
    const original = [
      'function handler(x) {',
      '  try {',
      '    risky(x);',
      '  } catch (e) {',
      '    log(x);',
      '  }',
      '}',
    ].join('\n');
    const instrumented = [
      'function handler(x) {',
      '  return tracer.startActiveSpan("handler", (span) => {',
      '    try {',
      '      risky(x);',
      '    } finally {',
      '      span.end();',
      '    }',
      '  });',
      '}',
    ].join('\n');

    const results = checkControlFlowPreservation(original, instrumented, '/services/handler.js');
    const failures = results.filter(r => !r.passed);

    expect(failures.length).toBeGreaterThan(0);
    expect(failures[0].ruleId).toBe('NDS-005');
    expect(failures[0].tier).toBe(2);
    expect(failures[0].blocking).toBe(true);
  });

  it('passes when a JS try/catch/finally block is preserved inside the span wrapper', () => {
    const original = [
      'function handler(x) {',
      '  try {',
      '    risky(x);',
      '  } catch (e) {',
      '    log(x);',
      '  } finally {',
      '    cleanup();',
      '  }',
      '}',
    ].join('\n');
    const instrumented = [
      'function handler(x) {',
      '  return tracer.startActiveSpan("handler", (span) => {',
      '    try {',
      '      try {',
      '        risky(x);',
      '      } catch (e) {',
      '        log(x);',
      '      } finally {',
      '        cleanup();',
      '      }',
      '    } finally {',
      '      span.end();',
      '    }',
      '  });',
      '}',
    ].join('\n');

    const results = checkControlFlowPreservation(original, instrumented, '/services/handler.js');
    expect(results.every(r => r.passed)).toBe(true);
  });

  it('flags a Python try/except block entirely removed from the instrumented output', () => {
    const original = [
      'def handler(x):',
      '    try:',
      '        risky(x)',
      '    except ValueError:',
      '        log(x)',
      '',
    ].join('\n');
    const instrumented = [
      'def handler(x):',
      '    with tracer.start_as_current_span("handler"):',
      '        risky(x)',
      '',
    ].join('\n');

    const results = checkPythonControlFlowPreservation(original, instrumented, '/services/handler.py');
    const failures = results.filter(r => !r.passed);

    expect(failures.length).toBeGreaterThan(0);
    expect(failures[0].ruleId).toBe('NDS-005');
    expect(failures[0].tier).toBe(2);
    expect(failures[0].blocking).toBe(true);
  });

  it('passes when a Python try/except/finally block is preserved inside the with-span', () => {
    const original = [
      'def handler(x):',
      '    try:',
      '        risky(x)',
      '    except ValueError as e:',
      '        raise',
      '    finally:',
      '        cleanup()',
      '',
    ].join('\n');
    const instrumented = [
      'def handler(x):',
      '    with tracer.start_as_current_span("handler"):',
      '        try:',
      '            risky(x)',
      '        except ValueError as e:',
      '            raise',
      '        finally:',
      '            cleanup()',
      '',
    ].join('\n');

    const results = checkPythonControlFlowPreservation(original, instrumented, '/services/handler.py');
    expect(results.every(r => r.passed)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// NDS-007: Expected-condition catch/except blocks must not gain error recording
// ─────────────────────────────────────────────────────────────────────────────

describe('NDS-007: Expected-condition catch/except blocks must not gain error recording', () => {
  it('flags recordException() newly added to a swallowing JS catch block', () => {
    const original = [
      'function load(path) {',
      '  try {',
      '    return readFile(path);',
      '  } catch (e) {',
      '    return null;',
      '  }',
      '}',
    ].join('\n');
    const instrumented = [
      'function load(path) {',
      '  return tracer.startActiveSpan("load", (span) => {',
      '    try {',
      '      try {',
      '        return readFile(path);',
      '      } catch (e) {',
      '        span.recordException(e);',
      '        return null;',
      '      }',
      '    } finally {',
      '      span.end();',
      '    }',
      '  });',
      '}',
    ].join('\n');

    const results = checkNoErrorRecordingInExpectedConditionCatches(original, instrumented, '/services/load.js');
    const failures = results.filter(r => !r.passed);

    expect(failures.length).toBeGreaterThan(0);
    expect(failures[0].ruleId).toBe('NDS-007');
    expect(failures[0].tier).toBe(2);
    expect(failures[0].blocking).toBe(true);
  });

  it('passes when JS error recording is added to a re-raising catch block', () => {
    const original = [
      'function load(path) {',
      '  try {',
      '    return readFile(path);',
      '  } catch (e) {',
      '    throw e;',
      '  }',
      '}',
    ].join('\n');
    const instrumented = [
      'function load(path) {',
      '  return tracer.startActiveSpan("load", (span) => {',
      '    try {',
      '      try {',
      '        return readFile(path);',
      '      } catch (e) {',
      '        span.recordException(e);',
      '        throw e;',
      '      }',
      '    } finally {',
      '      span.end();',
      '    }',
      '  });',
      '}',
    ].join('\n');

    const results = checkNoErrorRecordingInExpectedConditionCatches(original, instrumented, '/services/load.js');
    expect(results.every(r => r.passed)).toBe(true);
  });

  it('flags record_exception() newly added to a swallowing Python except block', () => {
    const original = [
      'def load(path):',
      '    try:',
      '        return open(path).read()',
      '    except FileNotFoundError:',
      '        return None',
      '',
    ].join('\n');
    const instrumented = [
      'def load(path):',
      '    with tracer.start_as_current_span("load") as span:',
      '        try:',
      '            return open(path).read()',
      '        except FileNotFoundError as e:',
      '            span.record_exception(e)',
      '            return None',
      '',
    ].join('\n');

    const results = checkPythonNoErrorRecordingInExpectedConditionExcepts(original, instrumented, '/services/load.py');
    const failures = results.filter(r => !r.passed);

    expect(failures.length).toBeGreaterThan(0);
    expect(failures[0].ruleId).toBe('NDS-007');
    expect(failures[0].tier).toBe(2);
    expect(failures[0].blocking).toBe(true);
  });

  it('passes when Python error recording is added to a re-raising except block', () => {
    const original = [
      'def load(path):',
      '    try:',
      '        return open(path).read()',
      '    except FileNotFoundError:',
      '        raise',
      '',
    ].join('\n');
    const instrumented = [
      'def load(path):',
      '    with tracer.start_as_current_span("load") as span:',
      '        try:',
      '            return open(path).read()',
      '        except FileNotFoundError as e:',
      '            span.record_exception(e)',
      '            raise',
      '',
    ].join('\n');

    const results = checkPythonNoErrorRecordingInExpectedConditionExcepts(original, instrumented, '/services/load.py');
    expect(results.every(r => r.passed)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CDQ-005: startActiveSpan/start_as_current_span preferred over startSpan/start_span
// ─────────────────────────────────────────────────────────────────────────────

describe('CDQ-005: startActiveSpan preferred over startSpan', () => {
  it('flags a JS tracer.startSpan() call', () => {
    const code = [
      'function handler(x) {',
      '  const span = tracer.startSpan("handler");',
      '  return x + 1;',
      '}',
    ].join('\n');

    const results = checkStartActiveSpanPreferred(code, '/services/handler.js');
    const failures = results.filter(r => !r.passed);

    expect(failures.length).toBeGreaterThan(0);
    expect(failures[0].ruleId).toBe('CDQ-005');
    expect(failures[0].tier).toBe(2);
    expect(failures[0].blocking).toBe(false);
  });

  it('passes when JS code uses startActiveSpan', () => {
    const code = [
      'function handler(x) {',
      '  return tracer.startActiveSpan("handler", (span) => {',
      '    try {',
      '      return x + 1;',
      '    } finally {',
      '      span.end();',
      '    }',
      '  });',
      '}',
    ].join('\n');

    const results = checkStartActiveSpanPreferred(code, '/services/handler.js');
    expect(results.every(r => r.passed)).toBe(true);
  });

  it('flags a Python tracer.start_span() call', () => {
    const code = [
      'def handler(x):',
      '    span = tracer.start_span("handler")',
      '    return x + 1',
      '',
    ].join('\n');

    const results = checkPythonStartActiveSpanPreferred(code, '/services/handler.py');
    const failures = results.filter(r => !r.passed);

    expect(failures.length).toBeGreaterThan(0);
    expect(failures[0].ruleId).toBe('CDQ-005');
    expect(failures[0].tier).toBe(2);
    expect(failures[0].blocking).toBe(false);
  });

  it('passes when Python code uses start_as_current_span', () => {
    const code = [
      'def handler(x):',
      '    with tracer.start_as_current_span("handler"):',
      '        return x + 1',
      '',
    ].join('\n');

    const results = checkPythonStartActiveSpanPreferred(code, '/services/handler.py');
    expect(results.every(r => r.passed)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CDQ-006: setAttribute/set_attribute computed values must be guarded by isRecording()
// ─────────────────────────────────────────────────────────────────────────────

describe('CDQ-006: setAttribute computed values must be guarded by isRecording()', () => {
  it('flags a JS setAttribute() with an expensive computation and no guard', () => {
    const code = [
      'function handler(span, x) {',
      '  span.setAttribute("payload", JSON.stringify(x));',
      '}',
    ].join('\n');

    const results = checkIsRecordingGuard(code, '/services/handler.js');
    const failures = results.filter(r => !r.passed);

    expect(failures.length).toBeGreaterThan(0);
    expect(failures[0].ruleId).toBe('CDQ-006');
    expect(failures[0].tier).toBe(2);
    expect(failures[0].blocking).toBe(false);
  });

  it('passes when a JS setAttribute() expensive computation is guarded', () => {
    const code = [
      'function handler(span, x) {',
      '  if (span.isRecording()) {',
      '    span.setAttribute("payload", JSON.stringify(x));',
      '  }',
      '}',
    ].join('\n');

    const results = checkIsRecordingGuard(code, '/services/handler.js');
    expect(results.every(r => r.passed)).toBe(true);
  });

  it('flags a Python set_attribute() with an expensive computation and no guard', () => {
    const code = [
      'def handler(span, x):',
      '    span.set_attribute("payload", json.dumps(x))',
      '',
    ].join('\n');

    const results = checkPythonIsRecordingGuard(code, '/services/handler.py');
    const failures = results.filter(r => !r.passed);

    expect(failures.length).toBeGreaterThan(0);
    expect(failures[0].ruleId).toBe('CDQ-006');
    expect(failures[0].tier).toBe(2);
    expect(failures[0].blocking).toBe(false);
  });

  it('passes when a Python set_attribute() expensive computation is guarded', () => {
    const code = [
      'def handler(span, x):',
      '    if span.is_recording():',
      '        span.set_attribute("payload", json.dumps(x))',
      '',
    ].join('\n');

    const results = checkPythonIsRecordingGuard(code, '/services/handler.py');
    expect(results.every(r => r.passed)).toBe(true);
  });
});

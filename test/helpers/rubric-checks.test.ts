// ABOUTME: Tests for rubric check helpers used in acceptance gate verification.
// ABOUTME: Verifies each rubric check correctly identifies passing and failing code.

import { describe, it, expect } from 'vitest';
import {
  checkSyntaxValid,
  checkNonInstrumentationLinesUnchanged,
  checkPublicApiPreserved,
  checkErrorHandlingPreserved,
  checkOtelImportsApiOnly,
  checkSpansClosed,
  checkTracerAcquired,
  checkErrorRecording,
  checkAsyncContext,
  checkAttributeSafety,
  checkNds005bNotViolated,
} from './rubric-checks.ts';

describe('NDS-001: checkSyntaxValid', () => {
  it('passes for valid JavaScript', () => {
    const result = checkSyntaxValid('const x = 1; function foo() { return x; }');
    expect(result.passed).toBe(true);
  });

  it('fails for invalid JavaScript', () => {
    const result = checkSyntaxValid('function foo( { return; }');
    expect(result.passed).toBe(false);
    expect(result.details).toContain('node --check failed');
  });
});

describe('NDS-003: checkNonInstrumentationLinesUnchanged', () => {
  it('passes when all original lines are preserved with added instrumentation', () => {
    const original = `export async function getUsers(req, res) {
  const result = await pool.query('SELECT * FROM users');
  res.json(result.rows);
}`;
    const instrumented = `import { trace, SpanStatusCode } from '@opentelemetry/api';

const tracer = trace.getTracer('my-service');

export async function getUsers(req, res) {
  return tracer.startActiveSpan('getUsers', async (span) => {
    try {
      const result = await pool.query('SELECT * FROM users');
      res.json(result.rows);
    } catch (error) {
      span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}`;
    const result = checkNonInstrumentationLinesUnchanged(original, instrumented);
    expect(result.passed).toBe(true);
  });

  it('fails when an original line is removed', () => {
    const original = `export async function getUsers(req, res) {
  const result = await pool.query('SELECT * FROM users');
  res.json(result.rows);
}`;
    const instrumented = `export async function getUsers(req, res) {
  res.json([]);
}`;
    const result = checkNonInstrumentationLinesUnchanged(original, instrumented);
    expect(result.passed).toBe(false);
    expect(result.details).toContain("pool.query");
  });

  it('fails when original lines are reordered', () => {
    const original = `export function process(data) {
  const validated = validate(data);
  const transformed = transform(validated);
  return save(transformed);
}`;
    const instrumented = `import { trace } from '@opentelemetry/api';
const tracer = trace.getTracer('svc');
export function process(data) {
  const transformed = transform(validated);
  const validated = validate(data);
  return save(transformed);
}`;
    const result = checkNonInstrumentationLinesUnchanged(original, instrumented);
    expect(result.passed).toBe(false);
    expect(result.details).toContain('reordered');
  });
});

describe('NDS-004: checkPublicApiPreserved', () => {
  it('passes when exported function signatures are preserved', () => {
    const original = `export async function getUsers(req, res) {
  res.json([]);
}
export function formatUser(user) {
  return user;
}`;
    const instrumented = `import { trace } from '@opentelemetry/api';
const tracer = trace.getTracer('svc');
export async function getUsers(req, res) {
  return tracer.startActiveSpan('getUsers', async (span) => {
    try { res.json([]); } finally { span.end(); }
  });
}
export function formatUser(user) {
  return user;
}`;
    const result = checkPublicApiPreserved(original, instrumented);
    expect(result.passed).toBe(true);
  });

  it('fails when an exported function is missing', () => {
    const original = `export function foo() {}
export function bar() {}`;
    const instrumented = `export function foo() {}`;
    const result = checkPublicApiPreserved(original, instrumented);
    expect(result.passed).toBe(false);
    expect(result.details).toContain('bar');
  });

  it('fails when parameter count changes', () => {
    const original = `export function foo(a, b) { return a + b; }`;
    const instrumented = `export function foo(a) { return a; }`;
    const result = checkPublicApiPreserved(original, instrumented);
    expect(result.passed).toBe(false);
    expect(result.details).toContain('parameter count');
  });
});

describe('NDS-005: checkErrorHandlingPreserved', () => {
  it('passes when original catch block content is preserved', () => {
    const original = `export async function createUser(req, res) {
  try {
    const result = await db.query('INSERT INTO users');
    res.json(result);
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ error: 'Duplicate' });
    }
    throw error;
  }
}`;
    const instrumented = `import { trace, SpanStatusCode } from '@opentelemetry/api';
const tracer = trace.getTracer('svc');
export async function createUser(req, res) {
  return tracer.startActiveSpan('createUser', async (span) => {
    try {
      const result = await db.query('INSERT INTO users');
      res.json(result);
    } catch (error) {
      span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR });
      if (error.code === '23505') {
        return res.status(409).json({ error: 'Duplicate' });
      }
      throw error;
    } finally {
      span.end();
    }
  });
}`;
    const result = checkErrorHandlingPreserved(original, instrumented);
    expect(result.passed).toBe(true);
  });

  it('passes when no catch blocks exist in original', () => {
    const original = `export function foo() { return 1; }`;
    const instrumented = `export function foo() { return 1; }`;
    const result = checkErrorHandlingPreserved(original, instrumented);
    expect(result.passed).toBe(true);
  });
});

describe('API-001: checkOtelImportsApiOnly', () => {
  it('passes for @opentelemetry/api imports', () => {
    const code = `import { trace, SpanStatusCode } from '@opentelemetry/api';`;
    const result = checkOtelImportsApiOnly(code);
    expect(result.passed).toBe(true);
  });

  it('fails for non-api OTel imports', () => {
    const code = `import { NodeSDK } from '@opentelemetry/sdk-node';
import { trace } from '@opentelemetry/api';`;
    const result = checkOtelImportsApiOnly(code);
    expect(result.passed).toBe(false);
    expect(result.details).toContain('@opentelemetry/sdk-node');
  });

  it('passes when no OTel imports exist', () => {
    const code = `import express from 'express';`;
    const result = checkOtelImportsApiOnly(code);
    expect(result.passed).toBe(true);
  });
});

describe('CDQ-001: checkSpansClosed', () => {
  it('passes when all spans have end() in finally', () => {
    const code = `export async function foo() {
  return tracer.startActiveSpan('foo', async (span) => {
    try { return 1; }
    catch (e) { throw e; }
    finally { span.end(); }
  });
}`;
    const result = checkSpansClosed(code);
    expect(result.passed).toBe(true);
  });

  it('fails when span.end() is missing from finally', () => {
    const code = `export async function foo() {
  return tracer.startActiveSpan('foo', async (span) => {
    try { return 1; }
    catch (e) { span.end(); throw e; }
  });
}`;
    const result = checkSpansClosed(code);
    expect(result.passed).toBe(false);
  });

  it('passes when no spans exist', () => {
    const result = checkSpansClosed('function foo() { return 1; }');
    expect(result.passed).toBe(true);
  });

  it('passes when finally block contains nested braces before span.end()', () => {
    const code = `export async function foo() {
  return tracer.startActiveSpan('foo', async (span) => {
    try { return await doWork(); }
    catch (e) { throw e; }
    finally {
      if (shouldLog) {
        logger.info('done');
      }
      span.end();
    }
  });
}`;
    const result = checkSpansClosed(code);
    expect(result.passed).toBe(true);
  });
});

describe('CDQ-002: checkTracerAcquired', () => {
  it('passes with string argument', () => {
    const code = `const tracer = trace.getTracer('my-service');`;
    const result = checkTracerAcquired(code);
    expect(result.passed).toBe(true);
  });

  it('fails without string argument', () => {
    const code = `const tracer = trace.getTracer();
tracer.startActiveSpan('foo', () => {});`;
    const result = checkTracerAcquired(code);
    expect(result.passed).toBe(false);
  });

  it('passes when no spans and no tracer', () => {
    const result = checkTracerAcquired('function foo() { return 1; }');
    expect(result.passed).toBe(true);
  });
});

describe('CDQ-003: checkErrorRecording', () => {
  it('passes with standard error recording pattern', () => {
    const code = `catch (error) {
      span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    }`;
    const result = checkErrorRecording(code);
    expect(result.passed).toBe(true);
  });

  it('fails when recordException is missing', () => {
    const code = `tracer.startActiveSpan('foo', async (span) => {
    try { return 1; }
    catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    }
    finally { span.end(); }
  });`;
    const result = checkErrorRecording(code);
    expect(result.passed).toBe(false);
    expect(result.details).toContain('recordException');
  });
});

describe('CDQ-005: checkAsyncContext', () => {
  it('passes with startActiveSpan (auto-managed context)', () => {
    const code = `tracer.startActiveSpan('foo', async (span) => {});`;
    const result = checkAsyncContext(code);
    expect(result.passed).toBe(true);
  });

  it('fails with startSpan without context.with', () => {
    const code = `const span = tracer.startSpan('foo');
doWork();
span.end();`;
    const result = checkAsyncContext(code);
    expect(result.passed).toBe(false);
    expect(result.details).toContain('context.with');
  });

  it('passes with startSpan and context.with', () => {
    const code = `const span = tracer.startSpan('foo');
context.with(trace.setSpan(context.active(), span), () => {
  doWork();
});
span.end();`;
    const result = checkAsyncContext(code);
    expect(result.passed).toBe(true);
  });
});

describe('CDQ-007: checkAttributeSafety', () => {
  it('passes with safe attributes', () => {
    const code = `span.setAttribute('user.id', userId);
span.setAttribute('db.row_count', result.rows.length);`;
    const result = checkAttributeSafety(code);
    expect(result.passed).toBe(true);
  });

  it('fails with JSON.stringify in setAttribute', () => {
    const code = `span.setAttribute('request.body', JSON.stringify(req.body));`;
    const result = checkAttributeSafety(code);
    expect(result.passed).toBe(false);
    expect(result.details).toContain('JSON.stringify');
  });

  it('fails with PII field patterns', () => {
    const code = `span.setAttribute('user.email', user.email);`;
    const result = checkAttributeSafety(code);
    expect(result.passed).toBe(false);
    expect(result.details).toContain('email');
  });

  it('passes with no setAttribute calls', () => {
    const result = checkAttributeSafety('function foo() { return 1; }');
    expect(result.passed).toBe(true);
  });
});

describe('NDS-005b: checkNds005bNotViolated', () => {
  it('passes when catch blocks have original logic alongside error recording', () => {
    const code = `
async function fetchData() {
  const tracer = trace.getTracer('service');
  return tracer.startActiveSpan('fetch', async (span) => {
    try {
      return await getData();
    } catch (err) {
      console.error('fetch failed:', err.message);
      span.recordException(err);
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw err;
    } finally {
      span.end();
    }
  });
}`;
    const result = checkNds005bNotViolated(code);
    expect(result.passed).toBe(true);
  });

  it('fails when a catch block contains only OTel error recording with no original logic', () => {
    // Originally-empty catch (expected-condition) that the agent wrongly added recordException to
    const code = `
async function checkExists(path) {
  const tracer = trace.getTracer('service');
  return tracer.startActiveSpan('check', async (span) => {
    try {
      await access(path);
      return true;
    } catch (err) {
      span.recordException(err);
      span.setStatus({ code: SpanStatusCode.ERROR });
    } finally {
      span.end();
    }
  });
}`;
    const result = checkNds005bNotViolated(code);
    expect(result.passed).toBe(false);
    expect(result.details).toContain('NDS-005b');
  });

  it('passes when catch blocks have no recordException', () => {
    const code = `
async function loadFile(path) {
  try {
    return await readFile(path);
  } catch {
    // File does not exist, return null
    return null;
  }
}`;
    const result = checkNds005bNotViolated(code);
    expect(result.passed).toBe(true);
  });

  it('passes when no try/catch blocks exist', () => {
    const result = checkNds005bNotViolated('function foo() { return 1; }');
    expect(result.passed).toBe(true);
  });
});

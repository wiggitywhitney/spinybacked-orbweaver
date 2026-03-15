// ABOUTME: Acceptance gate integration test for Phase 2 validation chain.
// ABOUTME: Tests the full chain against realistic instrumented JavaScript code.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validateFile } from '../../src/validation/chain.ts';
import { formatFeedbackForAgent } from '../../src/validation/feedback.ts';
import type { ValidateFileInput, ValidationConfig } from '../../src/validation/types.ts';

describe('Phase 2 acceptance gate', () => {
  let tempDir: string;

  const fullConfig: ValidationConfig = {
    enableWeaver: false,
    tier2Checks: {
      'CDQ-001': { enabled: true, blocking: true },
      'NDS-003': { enabled: true, blocking: true },
    },
  };

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'orbweaver-accept-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('passes full chain when instrumentation is correct', async () => {
    const original = [
      'const express = require("express");',
      '',
      'function handleRequest(req, res) {',
      '  const userId = req.params.id;',
      '  const user = lookupUser(userId);',
      '  res.json(user);',
      '}',
      '',
      'module.exports = { handleRequest };',
    ].join('\n');

    const instrumented = [
      'const express = require("express");',
      'const { trace, SpanStatusCode } = require("@opentelemetry/api");',
      'const tracer = trace.getTracer("user-service");',
      '',
      'function handleRequest(req, res) {',
      '  return tracer.startActiveSpan("handleRequest", (span) => {',
      '    try {',
      '      const userId = req.params.id;',
      '      span.setAttribute("user.id", userId);',
      '      const user = lookupUser(userId);',
      '      res.json(user);',
      '    } catch (error) {',
      '      span.recordException(error);',
      '      span.setStatus({ code: SpanStatusCode.ERROR });',
      '      throw error;',
      '    } finally {',
      '      span.end();',
      '    }',
      '  });',
      '}',
      '',
      'module.exports = { handleRequest };',
    ].join('\n');

    const filePath = join(tempDir, 'handler.js');
    writeFileSync(filePath, instrumented, 'utf-8');

    const input: ValidateFileInput = {
      originalCode: original,
      instrumentedCode: instrumented,
      filePath,
      config: fullConfig,
    };

    const result = await validateFile(input);

    expect(result.passed).toBe(true);
    expect(result.tier1Results.length).toBeGreaterThanOrEqual(3);
    expect(result.tier2Results).toHaveLength(2);
    expect(result.blockingFailures).toHaveLength(0);

    // Verify feedback format
    const feedback = formatFeedbackForAgent(result);
    expect(feedback).toContain('ELISION | pass');
    expect(feedback).toContain('NDS-001 | pass');
    expect(feedback).toContain('LINT | pass');
    expect(feedback).toContain('CDQ-001 | pass');
    expect(feedback).toContain('NDS-003 | pass');
  });

  it('detects elided output', async () => {
    const original = [
      'function processOrder(order) {',
      '  validateOrder(order);',
      '  const total = calculateTotal(order.items);',
      '  const tax = calculateTax(total);',
      '  const shipping = calculateShipping(order.address);',
      '  return { total, tax, shipping, grandTotal: total + tax + shipping };',
      '}',
    ].join('\n');

    const instrumented = [
      'function processOrder(order) {',
      '  // ... existing code',
      '}',
    ].join('\n');

    const filePath = join(tempDir, 'elided.js');
    writeFileSync(filePath, instrumented, 'utf-8');

    const result = await validateFile({
      originalCode: original,
      instrumentedCode: instrumented,
      filePath,
      config: fullConfig,
    });

    expect(result.passed).toBe(false);
    expect(result.tier1Results[0].ruleId).toBe('ELISION');
    expect(result.tier1Results[0].passed).toBe(false);
    // Short-circuit: no further checks
    expect(result.tier1Results).toHaveLength(1);
    expect(result.tier2Results).toHaveLength(0);

    const feedback = formatFeedbackForAgent(result);
    expect(feedback).toContain('ELISION | fail');
  });

  it('detects unclosed span (CDQ-001)', async () => {
    const original = [
      'function fetchData(url) {',
      '  return fetch(url).then((res) => res.json());',
      '}',
    ].join('\n');

    const instrumented = [
      'const { trace } = require("@opentelemetry/api");',
      'const tracer = trace.getTracer("data-service");',
      'function fetchData(url) {',
      '  return tracer.startActiveSpan("fetchData", (span) => {',
      '    return fetch(url).then((res) => res.json());',
      '    // missing span.end() in finally!',
      '  });',
      '}',
    ].join('\n');

    const filePath = join(tempDir, 'unclosed.js');
    writeFileSync(filePath, instrumented, 'utf-8');

    const result = await validateFile({
      originalCode: original,
      instrumentedCode: instrumented,
      filePath,
      config: fullConfig,
    });

    expect(result.passed).toBe(false);
    const cdq001 = result.tier2Results.find((r) => r.ruleId === 'CDQ-001');
    expect(cdq001).toBeDefined();
    expect(cdq001?.passed).toBe(false);
    expect(cdq001?.message).toContain('span.end()');

    const feedback = formatFeedbackForAgent(result);
    expect(feedback).toContain('CDQ-001 | fail');
  });

  it('detects business logic modification (NDS-003)', async () => {
    const original = [
      'function add(a, b) {',
      '  return a + b;',
      '}',
    ].join('\n');

    const instrumented = [
      'const { trace } = require("@opentelemetry/api");',
      'const tracer = trace.getTracer("math-service");',
      'function add(a, b) {',
      '  return tracer.startActiveSpan("add", (span) => {',
      '    try {',
      '      return a * b;', // Modified! + changed to *
      '    } finally {',
      '      span.end();',
      '    }',
      '  });',
      '}',
    ].join('\n');

    const filePath = join(tempDir, 'modified.js');
    writeFileSync(filePath, instrumented, 'utf-8');

    const result = await validateFile({
      originalCode: original,
      instrumentedCode: instrumented,
      filePath,
      config: fullConfig,
    });

    expect(result.passed).toBe(false);
    const nds003 = result.tier2Results.find((r) => r.ruleId === 'NDS-003');
    expect(nds003).toBeDefined();
    expect(nds003?.passed).toBe(false);

    const feedback = formatFeedbackForAgent(result);
    expect(feedback).toContain('NDS-003 | fail');
  });

  it('produces actionable diagnostics for all check failures', async () => {
    const original = 'function a() {\n  return 1;\n}\n';
    const instrumented = 'function a() {\n  // ...\n}\n';

    const filePath = join(tempDir, 'actionable.js');
    writeFileSync(filePath, instrumented, 'utf-8');

    const result = await validateFile({
      originalCode: original,
      instrumentedCode: instrumented,
      filePath,
      config: fullConfig,
    });

    for (const failure of result.blockingFailures) {
      // Every failure has a rule ID
      expect(failure.ruleId.length).toBeGreaterThan(0);
      // Every failure has a file path
      expect(failure.filePath).toBe(filePath);
      // Every failure has a substantive message
      expect(failure.message.length).toBeGreaterThan(20);
      // Message contains the rule ID for reference
      expect(failure.message).toContain(failure.ruleId);
    }
  });

  it('validates full chain with Tier 1 + Tier 2 against realistic Express handler', async () => {
    const original = [
      'const db = require("./db");',
      '',
      'async function getUser(req, res) {',
      '  try {',
      '    const user = await db.findById(req.params.id);',
      '    if (!user) {',
      '      return res.status(404).json({ error: "Not found" });',
      '    }',
      '    res.json(user);',
      '  } catch (err) {',
      '    console.error("DB error:", err);',
      '    res.status(500).json({ error: "Internal error" });',
      '  }',
      '}',
      '',
      'module.exports = { getUser };',
    ].join('\n');

    const instrumented = [
      'const db = require("./db");',
      'const { trace, SpanStatusCode } = require("@opentelemetry/api");',
      'const tracer = trace.getTracer("user-service");',
      '',
      'async function getUser(req, res) {',
      '  return tracer.startActiveSpan("getUser", async (span) => {',
      '    try {',
      '      const user = await db.findById(req.params.id);',
      '      if (!user) {',
      '        span.setAttribute("user.found", false);',
      '        return res.status(404).json({ error: "Not found" });',
      '      }',
      '      span.setAttribute("user.found", true);',
      '      res.json(user);',
      '    } catch (err) {',
      '      span.recordException(err);',
      '      span.setStatus({ code: SpanStatusCode.ERROR });',
      '      console.error("DB error:", err);',
      '      res.status(500).json({ error: "Internal error" });',
      '    } finally {',
      '      span.end();',
      '    }',
      '  });',
      '}',
      '',
      'module.exports = { getUser };',
    ].join('\n');

    const filePath = join(tempDir, 'user-handler.js');
    writeFileSync(filePath, instrumented, 'utf-8');

    const result = await validateFile({
      originalCode: original,
      instrumentedCode: instrumented,
      filePath,
      config: fullConfig,
    });

    expect(result.passed).toBe(true);
    expect(result.blockingFailures).toHaveLength(0);

    // All checks ran
    expect(result.tier1Results.length).toBeGreaterThanOrEqual(3);
    expect(result.tier2Results).toHaveLength(2);

    // Feedback is well-formed
    const feedback = formatFeedbackForAgent(result);
    const lines = feedback.split('\n').filter((l) => l.includes('|'));
    expect(lines.length).toBeGreaterThanOrEqual(5);
    expect(lines.every((l) => l.includes('pass'))).toBe(true);
  });
});

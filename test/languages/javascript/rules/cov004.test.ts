// ABOUTME: Tests for the COV-004 Tier 2 check — async operations have spans.
// ABOUTME: Verifies detection of async functions, await expressions, and I/O calls without spans.

import { describe, it, expect } from 'vitest';
import { checkAsyncOperationSpans } from '../../../../src/languages/javascript/rules/cov004.ts';

describe('checkAsyncOperationSpans (COV-004)', () => {
  const filePath = '/tmp/test-file.js';

  describe('no issues', () => {
    it('passes when no async functions exist', () => {
      const code = 'function greet(name) {\n  console.log("Hello " + name);\n}\n';

      const results = checkAsyncOperationSpans(code, filePath);

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
      expect(results[0].ruleId).toBe('COV-004');
      expect(results[0].tier).toBe(2);
      expect(results[0].blocking).toBe(false);
    });

    it('passes when async function has span', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'async function fetchData() {',
        '  return tracer.startActiveSpan("fetchData", async (span) => {',
        '    try {',
        '      const data = await fetch("/api/data");',
        '      return data.json();',
        '    } finally {',
        '      span.end();',
        '    }',
        '  });',
        '}',
      ].join('\n');

      const results = checkAsyncOperationSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });
  });

  describe('async functions without spans', () => {
    it('flags async function without span', () => {
      const code = [
        'async function fetchData() {',
        '  const response = await fetch("/api/data");',
        '  return response.json();',
        '}',
      ].join('\n');

      const results = checkAsyncOperationSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
      expect(results[0].ruleId).toBe('COV-004');
      expect(results[0].message).toContain('fetchData');
    });

    it('flags async arrow function without span', () => {
      const code = [
        'const getData = async () => {',
        '  const response = await fetch("/api/data");',
        '  return response.json();',
        '};',
      ].join('\n');

      const results = checkAsyncOperationSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
      expect(results[0].message).toContain('getData');
    });

    it('does not flag sync function with sync I/O calls', () => {
      const code = [
        'function readConfig(path) {',
        '  return fs.readFileSync(path, "utf-8");',
        '}',
      ].join('\n');

      const results = checkAsyncOperationSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('does not flag sync factory functions', () => {
      const code = [
        'function buildGraph() {',
        '  const graph = new StateGraph({ channels: {} });',
        '  graph.addNode("collect", collectNode);',
        '  return graph.compile();',
        '}',
      ].join('\n');

      const results = checkAsyncOperationSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('does not flag sync string builder functions', () => {
      const code = [
        'function dailySummaryPrompt(data) {',
        '  return `Generate a summary for ${data.date}`;',
        '}',
      ].join('\n');

      const results = checkAsyncOperationSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('flags async function with I/O calls without span', () => {
      const code = [
        'async function readConfig(path) {',
        '  return await fs.readFile(path, "utf-8");',
        '}',
      ].join('\n');

      const results = checkAsyncOperationSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
    });

    it('does not flag sync function without I/O', () => {
      const code = [
        'function add(a, b) {',
        '  return a + b;',
        '}',
      ].join('\n');

      const results = checkAsyncOperationSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });
  });

  describe('async callbacks passed as arguments', () => {
    it('does not flag async arrow function passed as argument to a call', () => {
      const code = [
        'server.registerTool("analyze", schema, async (args) => {',
        '  const result = await runAnalysis(args.input);',
        '  return { content: [{ type: "text", text: result }] };',
        '});',
      ].join('\n');

      const results = checkAsyncOperationSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('does not flag async function expression passed as argument', () => {
      const code = [
        'app.get("/api/data", async function handler(req, res) {',
        '  const data = await fetchData();',
        '  res.json(data);',
        '});',
      ].join('\n');

      const results = checkAsyncOperationSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('still flags top-level async arrow function assigned to a variable', () => {
      const code = [
        'const handler = async (args) => {',
        '  return await process(args);',
        '};',
      ].join('\n');

      const results = checkAsyncOperationSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
    });
  });

  describe('context propagation exemption — exported async functions', () => {
    it('flags exported ESM async function without span when file has instrumentation, with explicit message', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'export async function processOrchestrator(data) {',
        '  return tracer.startActiveSpan("processOrchestrator", async (span) => {',
        '    try { return await run(data); } finally { span.end(); }',
        '  });',
        '}',
        'export async function saveSummary(data) {',
        '  await fs.writeFile("summary.json", JSON.stringify(data));',
        '}',
      ].join('\n');

      const results = checkAsyncOperationSpans(code, filePath);
      const failure = results.find((r) => !r.passed && r.message.includes('saveSummary'));
      expect(failure).toBeDefined();
      expect(failure!.message).toContain('Context propagation');
      expect(failure!.message).toContain('RST-004');
      expect(failure!.message).toContain('RST-001');
    });

    it('flags CJS module.exports.X = async function without span', () => {
      const code = [
        'module.exports.readDayEntries = async function(dir) {',
        '  return await fs.readdir(dir);',
        '};',
      ].join('\n');

      const results = checkAsyncOperationSpans(code, filePath);
      const failures = results.filter((r) => !r.passed);
      expect(failures.length).toBeGreaterThan(0);
      expect(failures[0].message).toContain('readDayEntries');
    });

    it('passes CJS module.exports.X = async function when span is present', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'module.exports.readDayEntries = async function(dir) {',
        '  return tracer.startActiveSpan("readDayEntries", async (span) => {',
        '    try { return await fs.readdir(dir); } finally { span.end(); }',
        '  });',
        '};',
      ].join('\n');

      const results = checkAsyncOperationSpans(code, filePath);
      expect(results.every((r) => r.passed)).toBe(true);
    });

    it('flags CJS module.exports.X async when file has instrumentation, with explicit message', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'module.exports.processData = async function(data) {',
        '  return tracer.startActiveSpan("processData", async (span) => {',
        '    try { return await run(data); } finally { span.end(); }',
        '  });',
        '};',
        'module.exports.saveSummary = async function(data) {',
        '  await fs.writeFile("summary.json", JSON.stringify(data));',
        '};',
      ].join('\n');

      const results = checkAsyncOperationSpans(code, filePath);
      const failure = results.find((r) => !r.passed && r.message.includes('saveSummary'));
      expect(failure).toBeDefined();
      expect(failure!.message).toContain('Context propagation');
    });
  });

  describe('process.exit() exemption', () => {
    it('exempts async function with top-level process.exit() call', () => {
      const code = [
        'async function main(args) {',
        '  if (args.help) {',
        '    process.exit(0);',
        '  }',
        '  const result = await doWork(args);',
        '  return result;',
        '}',
      ].join('\n');

      const results = checkAsyncOperationSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('does not exempt async function with process.exit() only in finally block', () => {
      const code = [
        'async function withFinallyOnly(args) {',
        '  try {',
        '    const result = await doWork(args);',
        '    return result;',
        '  } finally {',
        '    process.exit(1);',
        '  }',
        '}',
      ].join('\n');

      const results = checkAsyncOperationSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
      expect(results[0].message).toContain('withFinallyOnly');
    });

    it('does not exempt async function with process.exit() only in catch block', () => {
      const code = [
        'async function safe(args) {',
        '  try {',
        '    const result = await doWork(args);',
        '    return result;',
        '  } catch (err) {',
        '    process.exit(1);',
        '  }',
        '}',
      ].join('\n');

      const results = checkAsyncOperationSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
      expect(results[0].message).toContain('safe');
    });

    it('does not exempt async function with process.exit() only in nested function', () => {
      const code = [
        'async function withNested() {',
        '  const handleExit = () => { process.exit(1); };',
        '  const result = await doWork();',
        '  return result;',
        '}',
      ].join('\n');

      const results = checkAsyncOperationSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
      expect(results[0].message).toContain('withNested');
    });

    it('exempts async function with process.exit() at top level and also in catch block', () => {
      const code = [
        'async function main(args) {',
        '  if (args.help) {',
        '    process.exit(0);',
        '  }',
        '  try {',
        '    const result = await doWork(args);',
        '    return result;',
        '  } catch (err) {',
        '    process.exit(1);',
        '  }',
        '}',
      ].join('\n');

      const results = checkAsyncOperationSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });
  });

  describe('CheckResult structure', () => {
    it('returns correct structure', () => {
      const code = 'const x = 1;\n';

      const results = checkAsyncOperationSpans(code, filePath);

      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({
        ruleId: 'COV-004',
        passed: true,
        filePath,
        lineNumber: null,
        message: expect.any(String),
        tier: 2,
        blocking: false,
      });
    });
  });
});

// ABOUTME: Tests for the COV-004 Tier 2 check — async operations have spans.
// ABOUTME: Verifies detection of async functions, await expressions, and I/O calls without spans.

import { describe, it, expect } from 'vitest';
import { checkAsyncOperationSpans } from '../../../src/validation/tier2/cov004.ts';

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

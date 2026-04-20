// ABOUTME: Tests for the API-001/004 combined Tier 2 check — forbidden import detection.
// ABOUTME: Verifies agent-added forbidden imports are flagged; pre-existing ones are ignored.

import { describe, it, expect } from 'vitest';
import { checkForbiddenImports } from '../../../../src/languages/javascript/rules/api001.ts';

describe('checkForbiddenImports (API-001/004)', () => {
  const filePath = '/tmp/test-file.js';
  const emptyOriginal = '';

  describe('clean imports (passing)', () => {
    it('passes when only @opentelemetry/api is imported (ESM)', () => {
      const code = [
        'import { trace } from "@opentelemetry/api";',
        'const tracer = trace.getTracer("svc");',
      ].join('\n');

      const results = checkForbiddenImports(emptyOriginal, code, filePath);

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
      expect(results[0].ruleId).toBe('API-001');
      expect(results[0].tier).toBe(2);
    });

    it('passes when only @opentelemetry/api is required (CJS)', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
      ].join('\n');

      const results = checkForbiddenImports(emptyOriginal, code, filePath);

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('passes when no OTel imports at all', () => {
      const code = [
        'const express = require("express");',
        'const app = express();',
      ].join('\n');

      const results = checkForbiddenImports(emptyOriginal, code, filePath);

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('passes with @opentelemetry/api and non-OTel imports', () => {
      const code = [
        'import { trace } from "@opentelemetry/api";',
        'import express from "express";',
        'import { readFile } from "fs/promises";',
      ].join('\n');

      const results = checkForbiddenImports(emptyOriginal, code, filePath);

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });
  });

  describe('API-001: OTel SDK imports added by agent (blocking)', () => {
    it('flags @opentelemetry/sdk-trace-node added by agent', () => {
      const original = 'import { trace } from "@opentelemetry/api";\n';
      const instrumented = [
        'import { trace } from "@opentelemetry/api";',
        'import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";',
      ].join('\n');

      const results = checkForbiddenImports(original, instrumented, filePath);
      const failures = results.filter(r => !r.passed);

      expect(failures).toHaveLength(1);
      expect(failures[0].ruleId).toBe('API-001');
      expect(failures[0].message).toContain('@opentelemetry/sdk-trace-node');
      expect(failures[0].lineNumber).toBe(2);
      expect(failures[0].blocking).toBe(true);
    });

    it('flags @opentelemetry/sdk-trace-base added by agent', () => {
      const code = 'import { SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";\n';

      const results = checkForbiddenImports(emptyOriginal, code, filePath);
      const failures = results.filter(r => !r.passed);

      expect(failures).toHaveLength(1);
      expect(failures[0].ruleId).toBe('API-001');
      expect(failures[0].message).toContain('@opentelemetry/sdk-trace-base');
      expect(failures[0].blocking).toBe(true);
    });

    it('flags @opentelemetry/exporter-trace-otlp-http added by agent', () => {
      const code = 'import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";\n';

      const results = checkForbiddenImports(emptyOriginal, code, filePath);
      const failures = results.filter(r => !r.passed);

      expect(failures).toHaveLength(1);
      expect(failures[0].ruleId).toBe('API-001');
      expect(failures[0].message).toContain('@opentelemetry/exporter-trace-otlp-http');
      expect(failures[0].blocking).toBe(true);
    });

    it('flags @opentelemetry/instrumentation-express added by agent', () => {
      const code = 'import { ExpressInstrumentation } from "@opentelemetry/instrumentation-express";\n';

      const results = checkForbiddenImports(emptyOriginal, code, filePath);
      const failures = results.filter(r => !r.passed);

      expect(failures).toHaveLength(1);
      expect(failures[0].ruleId).toBe('API-001');
      expect(failures[0].message).toContain('@opentelemetry/instrumentation-express');
      expect(failures[0].blocking).toBe(true);
    });

    it('flags @opentelemetry/sdk-metrics via CJS require', () => {
      const code = 'const { MeterProvider } = require("@opentelemetry/sdk-metrics");\n';

      const results = checkForbiddenImports(emptyOriginal, code, filePath);
      const failures = results.filter(r => !r.passed);

      expect(failures).toHaveLength(1);
      expect(failures[0].ruleId).toBe('API-001');
      expect(failures[0].blocking).toBe(true);
    });

    it('flags @opentelemetry/resources added by agent', () => {
      const code = 'import { Resource } from "@opentelemetry/resources";\n';

      const results = checkForbiddenImports(emptyOriginal, code, filePath);
      const failures = results.filter(r => !r.passed);

      expect(failures).toHaveLength(1);
      expect(failures[0].ruleId).toBe('API-001');
      expect(failures[0].blocking).toBe(true);
    });
  });

  describe('API-004: OTel SDK internal imports added by agent (blocking)', () => {
    it('flags @opentelemetry/core added by agent', () => {
      const code = 'import { hrTime } from "@opentelemetry/core";\n';

      const results = checkForbiddenImports(emptyOriginal, code, filePath);
      const failures = results.filter(r => !r.passed);

      expect(failures).toHaveLength(1);
      expect(failures[0].ruleId).toBe('API-004');
      expect(failures[0].message).toContain('@opentelemetry/core');
      expect(failures[0].blocking).toBe(true);
    });
  });

  describe('API-001: non-API OTel packages (semantic-conventions, resources)', () => {
    it('flags @opentelemetry/semantic-conventions added by agent', () => {
      const code = 'import { SEMATTRS_HTTP_METHOD } from "@opentelemetry/semantic-conventions";\n';

      const results = checkForbiddenImports(emptyOriginal, code, filePath);
      const failures = results.filter(r => !r.passed);

      expect(failures).toHaveLength(1);
      expect(failures[0].ruleId).toBe('API-001');
      expect(failures[0].message).toContain('@opentelemetry/semantic-conventions');
      expect(failures[0].blocking).toBe(true);
    });

    it('flags @opentelemetry/resources via CJS require added by agent', () => {
      const code = 'const { Resource } = require("@opentelemetry/resources");\n';

      const results = checkForbiddenImports(emptyOriginal, code, filePath);
      const failures = results.filter(r => !r.passed);

      expect(failures).toHaveLength(1);
      expect(failures[0].ruleId).toBe('API-001');
      expect(failures[0].blocking).toBe(true);
    });
  });

  describe('diff-based detection — pre-existing imports are not flagged', () => {
    it('does not flag a forbidden import that was already in the original', () => {
      const original = 'import { SEMATTRS_HTTP_METHOD } from "@opentelemetry/semantic-conventions";\n';
      const instrumented = [
        'import { trace } from "@opentelemetry/api";',
        'import { SEMATTRS_HTTP_METHOD } from "@opentelemetry/semantic-conventions";',
      ].join('\n');

      const results = checkForbiddenImports(original, instrumented, filePath);
      const failures = results.filter(r => !r.passed);

      expect(failures).toHaveLength(0);
    });

    it('does not flag a vendor import that was already in the original', () => {
      const original = 'const tracer = require("dd-trace").init();\n';
      const instrumented = [
        'import { trace } from "@opentelemetry/api";',
        'const tracer = require("dd-trace").init();',
      ].join('\n');

      const results = checkForbiddenImports(original, instrumented, filePath);
      const failures = results.filter(r => !r.passed);

      expect(failures).toHaveLength(0);
    });

    it('flags a new forbidden import while ignoring a pre-existing one', () => {
      const original = 'import { SEMATTRS_HTTP_METHOD } from "@opentelemetry/semantic-conventions";\n';
      const instrumented = [
        'import { trace } from "@opentelemetry/api";',
        'import { SEMATTRS_HTTP_METHOD } from "@opentelemetry/semantic-conventions";',
        'import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";',
      ].join('\n');

      const results = checkForbiddenImports(original, instrumented, filePath);
      const failures = results.filter(r => !r.passed);

      expect(failures).toHaveLength(1);
      expect(failures[0].ruleId).toBe('API-001');
      expect(failures[0].message).toContain('@opentelemetry/sdk-trace-node');
    });

    it('does not flag @opentelemetry/core that was already in the original', () => {
      const original = 'import { hrTime } from "@opentelemetry/core";\n';
      const instrumented = [
        'import { trace } from "@opentelemetry/api";',
        'import { hrTime } from "@opentelemetry/core";',
      ].join('\n');

      const results = checkForbiddenImports(original, instrumented, filePath);
      const failures = results.filter(r => !r.passed);

      expect(failures).toHaveLength(0);
    });
  });

  describe('multiple agent-added violations', () => {
    it('reports all agent-added forbidden imports in a single file', () => {
      const code = [
        'import { trace } from "@opentelemetry/api";',
        'import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";',
        'import { Resource } from "@opentelemetry/resources";',
      ].join('\n');

      const results = checkForbiddenImports(emptyOriginal, code, filePath);
      const failures = results.filter(r => !r.passed);

      expect(failures).toHaveLength(2);
      const lines = failures.map(f => f.lineNumber);
      expect(new Set(lines).size).toBe(2);
    });
  });

  describe('CJS require() patterns', () => {
    it('flags require("@opentelemetry/sdk-trace-node") added by agent', () => {
      const code = 'const { NodeTracerProvider } = require("@opentelemetry/sdk-trace-node");\n';

      const results = checkForbiddenImports(emptyOriginal, code, filePath);
      const failures = results.filter(r => !r.passed);

      expect(failures).toHaveLength(1);
      expect(failures[0].ruleId).toBe('API-001');
      expect(failures[0].blocking).toBe(true);
    });
  });

  describe('CheckResult structure', () => {
    it('returns correct structure for passing result', () => {
      const code = 'const x = 1;\n';

      const results = checkForbiddenImports(emptyOriginal, code, filePath);

      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({
        ruleId: 'API-001',
        passed: true,
        filePath,
        lineNumber: null,
        message: expect.any(String),
        tier: 2,
        blocking: false,
      });
    });

    it('returns correct structure for failing result — blocking:true', () => {
      const code = 'import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";\n';

      const results = checkForbiddenImports(emptyOriginal, code, filePath);
      const failure = results.find(r => !r.passed);

      expect(failure).toBeDefined();
      expect(failure!.ruleId).toBe('API-001');
      expect(failure!.tier).toBe(2);
      expect(failure!.blocking).toBe(true);
      expect(failure!.lineNumber).toBeGreaterThan(0);
      expect(failure!.message).toBeTruthy();
    });
  });
});

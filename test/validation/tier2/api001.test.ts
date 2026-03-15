// ABOUTME: Tests for the API-001/003/004 combined Tier 2 check — forbidden import detection.
// ABOUTME: Verifies detection of OTel SDK, vendor SDK, and OTel internal imports in instrumented code.

import { describe, it, expect } from 'vitest';
import { checkForbiddenImports } from '../../../src/validation/tier2/api001.ts';

describe('checkForbiddenImports (API-001/003/004)', () => {
  const filePath = '/tmp/test-file.js';

  describe('clean imports (passing)', () => {
    it('passes when only @opentelemetry/api is imported (ESM)', () => {
      const code = [
        'import { trace } from "@opentelemetry/api";',
        'const tracer = trace.getTracer("svc");',
      ].join('\n');

      const results = checkForbiddenImports(code, filePath);

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

      const results = checkForbiddenImports(code, filePath);

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('passes when no OTel imports at all', () => {
      const code = [
        'const express = require("express");',
        'const app = express();',
      ].join('\n');

      const results = checkForbiddenImports(code, filePath);

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('passes with @opentelemetry/api and non-OTel imports', () => {
      const code = [
        'import { trace } from "@opentelemetry/api";',
        'import express from "express";',
        'import { readFile } from "fs/promises";',
      ].join('\n');

      const results = checkForbiddenImports(code, filePath);

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });
  });

  describe('API-001: OTel SDK imports (forbidden)', () => {
    it('flags @opentelemetry/sdk-trace-node', () => {
      const code = [
        'import { trace } from "@opentelemetry/api";',
        'import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";',
      ].join('\n');

      const results = checkForbiddenImports(code, filePath);
      const failures = results.filter(r => !r.passed);

      expect(failures).toHaveLength(1);
      expect(failures[0].ruleId).toBe('API-001');
      expect(failures[0].message).toContain('@opentelemetry/sdk-trace-node');
      expect(failures[0].lineNumber).toBe(2);
    });

    it('flags @opentelemetry/sdk-trace-base', () => {
      const code = 'import { SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";\n';

      const results = checkForbiddenImports(code, filePath);
      const failures = results.filter(r => !r.passed);

      expect(failures).toHaveLength(1);
      expect(failures[0].ruleId).toBe('API-001');
      expect(failures[0].message).toContain('@opentelemetry/sdk-trace-base');
    });

    it('flags @opentelemetry/exporter-trace-otlp-http', () => {
      const code = 'import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";\n';

      const results = checkForbiddenImports(code, filePath);
      const failures = results.filter(r => !r.passed);

      expect(failures).toHaveLength(1);
      expect(failures[0].ruleId).toBe('API-001');
      expect(failures[0].message).toContain('@opentelemetry/exporter-trace-otlp-http');
    });

    it('flags @opentelemetry/instrumentation-express', () => {
      const code = 'import { ExpressInstrumentation } from "@opentelemetry/instrumentation-express";\n';

      const results = checkForbiddenImports(code, filePath);
      const failures = results.filter(r => !r.passed);

      expect(failures).toHaveLength(1);
      expect(failures[0].ruleId).toBe('API-001');
      expect(failures[0].message).toContain('@opentelemetry/instrumentation-express');
    });

    it('flags @opentelemetry/sdk-metrics', () => {
      const code = 'const { MeterProvider } = require("@opentelemetry/sdk-metrics");\n';

      const results = checkForbiddenImports(code, filePath);
      const failures = results.filter(r => !r.passed);

      expect(failures).toHaveLength(1);
      expect(failures[0].ruleId).toBe('API-001');
    });

    it('flags @opentelemetry/resources', () => {
      const code = 'import { Resource } from "@opentelemetry/resources";\n';

      const results = checkForbiddenImports(code, filePath);
      const failures = results.filter(r => !r.passed);

      expect(failures).toHaveLength(1);
      expect(failures[0].ruleId).toBe('API-001');
    });
  });

  describe('API-003: vendor-specific SDKs (forbidden)', () => {
    it('flags dd-trace', () => {
      const code = 'const tracer = require("dd-trace").init();\n';

      const results = checkForbiddenImports(code, filePath);
      const failures = results.filter(r => !r.passed);

      expect(failures).toHaveLength(1);
      expect(failures[0].ruleId).toBe('API-003');
      expect(failures[0].message).toContain('dd-trace');
    });

    it('flags @newrelic/native-metrics', () => {
      const code = 'import metrics from "@newrelic/native-metrics";\n';

      const results = checkForbiddenImports(code, filePath);
      const failures = results.filter(r => !r.passed);

      expect(failures).toHaveLength(1);
      expect(failures[0].ruleId).toBe('API-003');
      expect(failures[0].message).toContain('@newrelic/native-metrics');
    });

    it('flags @splunk/otel', () => {
      const code = 'import { startTracing } from "@splunk/otel";\n';

      const results = checkForbiddenImports(code, filePath);
      const failures = results.filter(r => !r.passed);

      expect(failures).toHaveLength(1);
      expect(failures[0].ruleId).toBe('API-003');
      expect(failures[0].message).toContain('@splunk/otel');
    });

    it('flags newrelic', () => {
      const code = 'const newrelic = require("newrelic");\n';

      const results = checkForbiddenImports(code, filePath);
      const failures = results.filter(r => !r.passed);

      expect(failures).toHaveLength(1);
      expect(failures[0].ruleId).toBe('API-003');
      expect(failures[0].message).toContain('newrelic');
    });

    it('flags @dynatrace/oneagent-sdk', () => {
      const code = 'import sdk from "@dynatrace/oneagent-sdk";\n';

      const results = checkForbiddenImports(code, filePath);
      const failures = results.filter(r => !r.passed);

      expect(failures).toHaveLength(1);
      expect(failures[0].ruleId).toBe('API-003');
    });

    it('flags elastic-apm-node', () => {
      const code = 'const apm = require("elastic-apm-node").start();\n';

      const results = checkForbiddenImports(code, filePath);
      const failures = results.filter(r => !r.passed);

      expect(failures).toHaveLength(1);
      expect(failures[0].ruleId).toBe('API-003');
    });
  });

  describe('API-004: OTel SDK internal imports (forbidden, same mechanism as API-001)', () => {
    it('flags @opentelemetry/core', () => {
      const code = 'import { hrTime } from "@opentelemetry/core";\n';

      const results = checkForbiddenImports(code, filePath);
      const failures = results.filter(r => !r.passed);

      expect(failures).toHaveLength(1);
      expect(failures[0].ruleId).toBe('API-001');
      expect(failures[0].message).toContain('@opentelemetry/core');
    });

    it('flags @opentelemetry/semantic-conventions', () => {
      const code = 'import { SEMATTRS_HTTP_METHOD } from "@opentelemetry/semantic-conventions";\n';

      const results = checkForbiddenImports(code, filePath);
      const failures = results.filter(r => !r.passed);

      expect(failures).toHaveLength(1);
      expect(failures[0].ruleId).toBe('API-001');
      expect(failures[0].message).toContain('@opentelemetry/semantic-conventions');
    });

    it('flags @opentelemetry/resources (SDK internal)', () => {
      const code = 'const { Resource } = require("@opentelemetry/resources");\n';

      const results = checkForbiddenImports(code, filePath);
      const failures = results.filter(r => !r.passed);

      expect(failures).toHaveLength(1);
      expect(failures[0].ruleId).toBe('API-001');
    });
  });

  describe('multiple violations', () => {
    it('reports all forbidden imports in a single file', () => {
      const code = [
        'import { trace } from "@opentelemetry/api";',
        'import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";',
        'const ddTrace = require("dd-trace");',
        'import { Resource } from "@opentelemetry/resources";',
      ].join('\n');

      const results = checkForbiddenImports(code, filePath);
      const failures = results.filter(r => !r.passed);

      expect(failures).toHaveLength(3);
      // Each failure should have a distinct line number
      const lines = failures.map(f => f.lineNumber);
      expect(new Set(lines).size).toBe(3);
    });
  });

  describe('CJS require() patterns', () => {
    it('flags require("dd-trace")', () => {
      const code = 'const tracer = require("dd-trace");\n';

      const results = checkForbiddenImports(code, filePath);
      const failures = results.filter(r => !r.passed);

      expect(failures).toHaveLength(1);
      expect(failures[0].ruleId).toBe('API-003');
    });

    it('flags require("@opentelemetry/sdk-trace-node")', () => {
      const code = 'const { NodeTracerProvider } = require("@opentelemetry/sdk-trace-node");\n';

      const results = checkForbiddenImports(code, filePath);
      const failures = results.filter(r => !r.passed);

      expect(failures).toHaveLength(1);
      expect(failures[0].ruleId).toBe('API-001');
    });
  });

  describe('CheckResult structure', () => {
    it('returns correct structure for passing result', () => {
      const code = 'const x = 1;\n';

      const results = checkForbiddenImports(code, filePath);

      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({
        ruleId: 'API-001',
        passed: true,
        filePath,
        lineNumber: null,
        message: expect.any(String),
        tier: 2,
        blocking: true,
      });
    });

    it('returns correct structure for failing result', () => {
      const code = 'import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";\n';

      const results = checkForbiddenImports(code, filePath);
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

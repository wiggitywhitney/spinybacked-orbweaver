// ABOUTME: Tests for NDS-006 Tier 2 check — module system preservation.
// ABOUTME: Verifies detection of ESM/CJS mismatch between original and instrumented code.

import { describe, it, expect } from 'vitest';
import { checkModuleSystemMatch } from '../../../src/validation/tier2/nds006.ts';

describe('checkModuleSystemMatch (NDS-006)', () => {
  const filePath = '/tmp/test-file.js';

  describe('ESM original stays ESM (passing)', () => {
    it('passes when both use ESM imports', () => {
      const original = [
        'import express from "express";',
        'const app = express();',
        'export default app;',
      ].join('\n');

      const instrumented = [
        'import express from "express";',
        'import { trace } from "@opentelemetry/api";',
        'const app = express();',
        'export default app;',
      ].join('\n');

      const results = checkModuleSystemMatch(original, instrumented, filePath);

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
      expect(results[0].ruleId).toBe('NDS-006');
    });

    it('passes with named exports preserved', () => {
      const original = [
        'import { readFile } from "fs/promises";',
        'export function handler() { return readFile("x"); }',
      ].join('\n');

      const instrumented = [
        'import { readFile } from "fs/promises";',
        'import { trace } from "@opentelemetry/api";',
        'export function handler() { return readFile("x"); }',
      ].join('\n');

      const results = checkModuleSystemMatch(original, instrumented, filePath);

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });
  });

  describe('CJS original stays CJS (passing)', () => {
    it('passes when both use require/module.exports', () => {
      const original = [
        'const express = require("express");',
        'const app = express();',
        'module.exports = app;',
      ].join('\n');

      const instrumented = [
        'const express = require("express");',
        'const { trace } = require("@opentelemetry/api");',
        'const app = express();',
        'module.exports = app;',
      ].join('\n');

      const results = checkModuleSystemMatch(original, instrumented, filePath);

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
      expect(results[0].ruleId).toBe('NDS-006');
    });

    it('passes with exports.prop pattern', () => {
      const original = [
        'const db = require("./db");',
        'exports.getUser = function(id) { return db.find(id); };',
      ].join('\n');

      const instrumented = [
        'const db = require("./db");',
        'const { trace } = require("@opentelemetry/api");',
        'exports.getUser = function(id) { return db.find(id); };',
      ].join('\n');

      const results = checkModuleSystemMatch(original, instrumented, filePath);

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });
  });

  describe('ESM original gets CJS instrumentation (failing)', () => {
    it('flags require() added to ESM file', () => {
      const original = [
        'import express from "express";',
        'export default express();',
      ].join('\n');

      const instrumented = [
        'import express from "express";',
        'const { trace } = require("@opentelemetry/api");',
        'export default express();',
      ].join('\n');

      const results = checkModuleSystemMatch(original, instrumented, filePath);
      const failures = results.filter(r => !r.passed);

      expect(failures).toHaveLength(1);
      expect(failures[0].ruleId).toBe('NDS-006');
      expect(failures[0].message).toContain('NDS-006');
      expect(failures[0].message).toContain('require');
      expect(failures[0].tier).toBe(2);
    });

    it('flags module.exports added to ESM file', () => {
      const original = [
        'import { readFile } from "fs/promises";',
        'export async function load() { return readFile("x"); }',
      ].join('\n');

      const instrumented = [
        'import { readFile } from "fs/promises";',
        'async function load() { return readFile("x"); }',
        'module.exports = { load };',
      ].join('\n');

      const results = checkModuleSystemMatch(original, instrumented, filePath);
      const failures = results.filter(r => !r.passed);

      expect(failures.length).toBeGreaterThanOrEqual(1);
      expect(failures[0].ruleId).toBe('NDS-006');
    });
  });

  describe('CJS original gets ESM instrumentation (failing)', () => {
    it('flags import statement added to CJS file', () => {
      const original = [
        'const express = require("express");',
        'module.exports = express();',
      ].join('\n');

      const instrumented = [
        'const express = require("express");',
        'import { trace } from "@opentelemetry/api";',
        'module.exports = express();',
      ].join('\n');

      const results = checkModuleSystemMatch(original, instrumented, filePath);
      const failures = results.filter(r => !r.passed);

      expect(failures).toHaveLength(1);
      expect(failures[0].ruleId).toBe('NDS-006');
      expect(failures[0].message).toContain('NDS-006');
      expect(failures[0].message).toContain('import');
    });

    it('flags export statement added to CJS file', () => {
      const original = [
        'const db = require("./db");',
        'module.exports.getUser = function(id) { return db.find(id); };',
      ].join('\n');

      const instrumented = [
        'const db = require("./db");',
        'export function getUser(id) { return db.find(id); }',
      ].join('\n');

      const results = checkModuleSystemMatch(original, instrumented, filePath);
      const failures = results.filter(r => !r.passed);

      expect(failures.length).toBeGreaterThanOrEqual(1);
      expect(failures[0].ruleId).toBe('NDS-006');
    });
  });

  describe('ambiguous/no-signal files (passing)', () => {
    it('passes when original has no module signals', () => {
      const original = [
        'function add(a, b) { return a + b; }',
      ].join('\n');

      const instrumented = [
        'import { trace } from "@opentelemetry/api";',
        'function add(a, b) { return a + b; }',
      ].join('\n');

      const results = checkModuleSystemMatch(original, instrumented, filePath);

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('passes when both have no module signals', () => {
      const original = 'function x() { return 1; }';
      const instrumented = 'function x() { return 1; }';

      const results = checkModuleSystemMatch(original, instrumented, filePath);

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('flags when an ESM file loses its only export signal', () => {
      const original = [
        'const app = createApp();',
        'export default app;',
      ].join('\n');

      const instrumented = [
        'const app = createApp();',
      ].join('\n');

      const failures = checkModuleSystemMatch(original, instrumented, filePath).filter(r => !r.passed);

      expect(failures).toHaveLength(1);
      expect(failures[0].ruleId).toBe('NDS-006');
      expect(failures[0].message).toContain('signal lost');
    });

    it('flags when a CJS file loses its only require signal', () => {
      const original = [
        'const fs = require("fs");',
        'function read() { return fs.readFileSync("x"); }',
      ].join('\n');

      const instrumented = [
        'function read() { return "mock"; }',
      ].join('\n');

      const failures = checkModuleSystemMatch(original, instrumented, filePath).filter(r => !r.passed);

      expect(failures).toHaveLength(1);
      expect(failures[0].ruleId).toBe('NDS-006');
      expect(failures[0].message).toContain('signal lost');
    });
  });

  describe('mixed module system in original', () => {
    it('passes when original already mixes ESM and CJS', () => {
      // Some files legitimately have both (e.g., dynamic require in ESM)
      const original = [
        'import path from "path";',
        'const config = require("./config.json");',
        'export default config;',
      ].join('\n');

      const instrumented = [
        'import path from "path";',
        'import { trace } from "@opentelemetry/api";',
        'const config = require("./config.json");',
        'export default config;',
      ].join('\n');

      const results = checkModuleSystemMatch(original, instrumented, filePath);

      // Mixed originals should pass — we can't reliably enforce purity
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });
  });

  describe('CheckResult structure', () => {
    it('returns correct structure for passing result', () => {
      const original = 'import x from "x";\nexport default x;';
      const instrumented = 'import x from "x";\nimport { trace } from "@opentelemetry/api";\nexport default x;';

      const results = checkModuleSystemMatch(original, instrumented, filePath);

      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({
        ruleId: 'NDS-006',
        passed: true,
        filePath,
        lineNumber: null,
        message: expect.any(String),
        tier: 2,
        blocking: false,
      });
    });

    it('returns correct structure for failing result', () => {
      const original = 'import x from "x";\nexport default x;';
      const instrumented = 'import x from "x";\nconst { trace } = require("@opentelemetry/api");\nexport default x;';

      const results = checkModuleSystemMatch(original, instrumented, filePath);
      const failure = results.find(r => !r.passed);

      expect(failure).toBeDefined();
      expect(failure!.ruleId).toBe('NDS-006');
      expect(failure!.tier).toBe(2);
      expect(failure!.blocking).toBe(false);
      expect(failure!.lineNumber).toBeGreaterThan(0);
      expect(failure!.message).toBeTruthy();
    });
  });
});

// ABOUTME: Tests for NDS-004 Tier 2 check — exported function signature preservation.
// ABOUTME: Verifies detection of added/removed/changed parameters on exported functions.

import { describe, it, expect } from 'vitest';
import { checkExportedSignaturePreservation } from '../../../../src/languages/javascript/rules/nds004.ts';

describe('checkExportedSignaturePreservation (NDS-004)', () => {
  const filePath = '/tmp/test-file.js';

  describe('signatures preserved (passing)', () => {
    it('passes when exported function signatures are unchanged', () => {
      const original = [
        'export function getUser(id) {',
        '  return db.find(id);',
        '}',
      ].join('\n');

      const instrumented = [
        'import { trace } from "@opentelemetry/api";',
        'const tracer = trace.getTracer("my-service");',
        'export function getUser(id) {',
        '  return tracer.startActiveSpan("getUser", (span) => {',
        '    try {',
        '      return db.find(id);',
        '    } finally {',
        '      span.end();',
        '    }',
        '  });',
        '}',
      ].join('\n');

      const results = checkExportedSignaturePreservation(original, instrumented, filePath);

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
      expect(results[0].ruleId).toBe('NDS-004');
    });

    it('passes when multiple exported functions preserve signatures', () => {
      const original = [
        'export function getUser(id) { return db.find(id); }',
        'export function createUser(name, email) { return db.create({ name, email }); }',
        'export default function main() { console.log("hi"); }',
      ].join('\n');

      const instrumented = [
        'import { trace } from "@opentelemetry/api";',
        'export function getUser(id) { return db.find(id); }',
        'export function createUser(name, email) { return db.create({ name, email }); }',
        'export default function main() { console.log("hi"); }',
      ].join('\n');

      const results = checkExportedSignaturePreservation(original, instrumented, filePath);

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('passes when non-exported functions change signatures', () => {
      const original = [
        'function internal(a) { return a; }',
        'export function pub(x) { return internal(x); }',
      ].join('\n');

      const instrumented = [
        'function internal(a, span) { return a; }',
        'export function pub(x) { return internal(x); }',
      ].join('\n');

      const results = checkExportedSignaturePreservation(original, instrumented, filePath);

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('passes with CJS module.exports functions preserved', () => {
      const original = [
        'function getUser(id) { return db.find(id); }',
        'module.exports = { getUser };',
      ].join('\n');

      const instrumented = [
        'const { trace } = require("@opentelemetry/api");',
        'function getUser(id) { return db.find(id); }',
        'module.exports = { getUser };',
      ].join('\n');

      const results = checkExportedSignaturePreservation(original, instrumented, filePath);

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('passes when no exported functions exist', () => {
      const original = 'function helper(x) { return x + 1; }';
      const instrumented = 'function helper(x) { return x + 1; }';

      const results = checkExportedSignaturePreservation(original, instrumented, filePath);

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('passes with arrow function exports preserved', () => {
      const original = [
        'export const getUser = (id) => db.find(id);',
        'export const createUser = (name, email) => db.create({ name, email });',
      ].join('\n');

      const instrumented = [
        'import { trace } from "@opentelemetry/api";',
        'export const getUser = (id) => db.find(id);',
        'export const createUser = (name, email) => db.create({ name, email });',
      ].join('\n');

      const results = checkExportedSignaturePreservation(original, instrumented, filePath);

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });
  });

  describe('parameter added to exported function (failing)', () => {
    it('flags when a parameter is added to an exported function', () => {
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

      const results = checkExportedSignaturePreservation(original, instrumented, filePath);
      const failures = results.filter(r => !r.passed);

      expect(failures).toHaveLength(1);
      expect(failures[0].ruleId).toBe('NDS-004');
      expect(failures[0].message).toContain('NDS-004');
      expect(failures[0].message).toContain('getUser');
      expect(failures[0].tier).toBe(2);
    });

    it('flags when a default export function gets extra parameters', () => {
      const original = [
        'export default function handler(req, res) {',
        '  res.send("ok");',
        '}',
      ].join('\n');

      const instrumented = [
        'export default function handler(req, res, next) {',
        '  res.send("ok");',
        '}',
      ].join('\n');

      const results = checkExportedSignaturePreservation(original, instrumented, filePath);
      const failures = results.filter(r => !r.passed);

      expect(failures).toHaveLength(1);
      expect(failures[0].ruleId).toBe('NDS-004');
      expect(failures[0].message).toContain('handler');
    });
  });

  describe('parameter removed from exported function (failing)', () => {
    it('flags when a parameter is removed from an exported function', () => {
      const original = [
        'export function createUser(name, email) {',
        '  return db.create({ name, email });',
        '}',
      ].join('\n');

      const instrumented = [
        'export function createUser(name) {',
        '  return db.create({ name });',
        '}',
      ].join('\n');

      const results = checkExportedSignaturePreservation(original, instrumented, filePath);
      const failures = results.filter(r => !r.passed);

      expect(failures).toHaveLength(1);
      expect(failures[0].ruleId).toBe('NDS-004');
      expect(failures[0].message).toContain('createUser');
    });
  });

  describe('parameter renamed in exported function (failing)', () => {
    it('flags when a parameter is renamed in an exported function', () => {
      const original = [
        'export function getUser(userId) {',
        '  return db.find(userId);',
        '}',
      ].join('\n');

      const instrumented = [
        'export function getUser(id) {',
        '  return db.find(id);',
        '}',
      ].join('\n');

      const results = checkExportedSignaturePreservation(original, instrumented, filePath);
      const failures = results.filter(r => !r.passed);

      expect(failures).toHaveLength(1);
      expect(failures[0].ruleId).toBe('NDS-004');
      expect(failures[0].message).toContain('getUser');
    });
  });

  describe('multiple violations', () => {
    it('reports one failure per violated exported function', () => {
      const original = [
        'export function getUser(id) { return db.find(id); }',
        'export function createUser(name, email) { return db.create({ name, email }); }',
      ].join('\n');

      const instrumented = [
        'export function getUser(id, span) { return db.find(id); }',
        'export function createUser(name) { return db.create({ name }); }',
      ].join('\n');

      const results = checkExportedSignaturePreservation(original, instrumented, filePath);
      const failures = results.filter(r => !r.passed);

      expect(failures).toHaveLength(2);
      expect(failures.map(f => f.message).join(' ')).toContain('getUser');
      expect(failures.map(f => f.message).join(' ')).toContain('createUser');
    });
  });

  describe('exported function removed entirely (failing)', () => {
    it('flags when an exported function is missing from instrumented output', () => {
      const original = [
        'export function getUser(id) { return db.find(id); }',
        'export function deleteUser(id) { return db.remove(id); }',
      ].join('\n');

      const instrumented = [
        'export function getUser(id) { return db.find(id); }',
      ].join('\n');

      const results = checkExportedSignaturePreservation(original, instrumented, filePath);
      const failures = results.filter(r => !r.passed);

      expect(failures).toHaveLength(1);
      expect(failures[0].ruleId).toBe('NDS-004');
      expect(failures[0].message).toContain('deleteUser');
    });
  });

  describe('exports.prop CJS pattern', () => {
    it('flags when CJS exported function signature changes', () => {
      const original = [
        'exports.getUser = function(id) { return db.find(id); };',
      ].join('\n');

      const instrumented = [
        'exports.getUser = function(id, span) { return db.find(id); };',
      ].join('\n');

      const results = checkExportedSignaturePreservation(original, instrumented, filePath);
      const failures = results.filter(r => !r.passed);

      expect(failures).toHaveLength(1);
      expect(failures[0].ruleId).toBe('NDS-004');
      expect(failures[0].message).toContain('getUser');
    });
  });

  describe('CheckResult structure', () => {
    it('returns correct structure for passing result', () => {
      const original = 'export function x(a) { return a; }';
      const instrumented = 'export function x(a) { return a; }';

      const results = checkExportedSignaturePreservation(original, instrumented, filePath);

      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({
        ruleId: 'NDS-004',
        passed: true,
        filePath,
        lineNumber: null,
        message: expect.any(String),
        tier: 2,
        blocking: false,
      });
    });

    it('returns correct structure for failing result', () => {
      const original = 'export function x(a) { return a; }';
      const instrumented = 'export function x(a, b) { return a; }';

      const results = checkExportedSignaturePreservation(original, instrumented, filePath);
      const failure = results.find(r => !r.passed);

      expect(failure).toBeDefined();
      expect(failure!.ruleId).toBe('NDS-004');
      expect(failure!.tier).toBe(2);
      expect(failure!.blocking).toBe(false);
      expect(failure!.lineNumber).toBeGreaterThan(0);
      expect(failure!.message).toBeTruthy();
    });
  });
});

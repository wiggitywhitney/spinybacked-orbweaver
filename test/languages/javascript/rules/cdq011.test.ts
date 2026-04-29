// ABOUTME: Tests for CDQ-011 blocking check — canonical tracer name enforcement.
// ABOUTME: Verifies trace.getTracer() string literals match the project's canonical tracer name.

import { describe, it, expect } from 'vitest';
import { checkCanonicalTracerName } from '../../../../src/languages/javascript/rules/cdq011.ts';

describe('checkCanonicalTracerName (CDQ-011)', () => {
  const filePath = '/tmp/test-file.js';
  const canonical = 'commit-story';

  describe('passes when tracer name matches canonical', () => {
    it('passes when single-quoted getTracer matches canonical', () => {
      const code = [
        "import { trace } from '@opentelemetry/api';",
        "const tracer = trace.getTracer('commit-story');",
        'async function fetchData() {',
        "  return tracer.startActiveSpan('fetch', (span) => { span.end(); });",
        '}',
      ].join('\n');

      const results = checkCanonicalTracerName(code, filePath, canonical);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
      expect(results[0].ruleId).toBe('CDQ-011');
    });

    it('passes when double-quoted getTracer matches canonical', () => {
      const code = [
        'import { trace } from "@opentelemetry/api";',
        'const tracer = trace.getTracer("commit-story");',
      ].join('\n');

      const results = checkCanonicalTracerName(code, filePath, canonical);
      expect(results[0].passed).toBe(true);
    });

    it('passes when file has no getTracer() call at all', () => {
      const code = [
        'async function doWork() {',
        '  return fetch("https://example.com");',
        '}',
      ].join('\n');

      const results = checkCanonicalTracerName(code, filePath, canonical);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('passes when getTracer is called with a backtick template literal matching canonical', () => {
      const code = [
        "import { trace } from '@opentelemetry/api';",
        'const tracer = trace.getTracer(`commit-story`);',
      ].join('\n');

      const results = checkCanonicalTracerName(code, filePath, canonical);
      expect(results[0].passed).toBe(true);
    });

    it('passes when getTracer is called on an unrelated object (not trace)', () => {
      const code = [
        "import { trace } from '@opentelemetry/api';",
        "const tracer = trace.getTracer('commit-story');",
        "const otherTracer = sdk.getTracer('wrong-name');",
      ].join('\n');

      const results = checkCanonicalTracerName(code, filePath, canonical);
      // Only the trace.getTracer() call is checked — sdk.getTracer() is ignored
      expect(results[0].passed).toBe(true);
    });
  });

  describe('fails when tracer name does not match canonical', () => {
    it('fails when getTracer uses underscores instead of hyphens', () => {
      const code = [
        "import { trace } from '@opentelemetry/api';",
        "const tracer = trace.getTracer('commit_story');",
      ].join('\n');

      const results = checkCanonicalTracerName(code, filePath, canonical);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
      expect(results[0].ruleId).toBe('CDQ-011');
      expect(results[0].tier).toBe(2);
      expect(results[0].blocking).toBe(true);
      expect(results[0].message).toContain('commit_story');
      expect(results[0].message).toContain('commit-story');
    });

    it('fails when getTracer uses a completely different name', () => {
      const code = [
        "import { trace } from '@opentelemetry/api';",
        "const tracer = trace.getTracer('wrong-name');",
      ].join('\n');

      const results = checkCanonicalTracerName(code, filePath, canonical);
      expect(results[0].passed).toBe(false);
      expect(results[0].message).toContain('wrong-name');
      expect(results[0].message).toContain('commit-story');
    });

    it('fails when one of two getTracer calls uses the wrong name', () => {
      const code = [
        "import { trace } from '@opentelemetry/api';",
        "const tracer = trace.getTracer('commit-story');",
        "const otherTracer = trace.getTracer('wrong-service');",
      ].join('\n');

      const results = checkCanonicalTracerName(code, filePath, canonical);
      const failures = results.filter(r => !r.passed);
      expect(failures).toHaveLength(1);
      expect(failures[0].message).toContain('wrong-service');
    });

    it('fails when getTracer uses a wrong backtick template literal', () => {
      const code = [
        "import { trace } from '@opentelemetry/api';",
        'const tracer = trace.getTracer(`wrong-name`);',
      ].join('\n');

      const results = checkCanonicalTracerName(code, filePath, canonical);
      expect(results[0].passed).toBe(false);
      expect(results[0].message).toContain('wrong-name');
      expect(results[0].message).toContain('commit-story');
    });

    it('includes line number in the finding', () => {
      const code = [
        "import { trace } from '@opentelemetry/api';",
        '',
        "const tracer = trace.getTracer('wrong-name');",
      ].join('\n');

      const results = checkCanonicalTracerName(code, filePath, canonical);
      const failure = results.find(r => !r.passed);
      expect(failure?.lineNumber).toBe(3);
    });
  });
});

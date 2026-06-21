// ABOUTME: Tests for CDQ-011 blocking check — canonical tracer name enforcement.
// ABOUTME: Verifies trace.getTracer() string literals match the project's canonical tracer name.

import { describe, it, expect } from 'vitest';
import { checkCanonicalTracerName, fixCanonicalTracerName } from '../../../../src/languages/javascript/rules/cdq011.ts';

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

    it('passes when getTracer uses an interpolated template literal (treated as variable-based)', () => {
      // Interpolated template literals are excluded from the check — they contain `$`
      // and therefore match no canonical name, but the graceful pass applies
      const code = [
        "import { trace } from '@opentelemetry/api';",
        'const tracer = trace.getTracer(`svc-${env}`);',
      ].join('\n');

      const results = checkCanonicalTracerName(code, filePath, canonical);
      // Should pass — interpolated template literals are not checked (treated as variable-based)
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

describe('fixCanonicalTracerName (CDQ-011 auto-fix)', () => {
  const canonical = 'commit-story';

  describe('no-op cases', () => {
    it('returns code unchanged when canonicalTracerName is undefined', () => {
      const code = "const tracer = trace.getTracer('wrong-name');";
      expect(fixCanonicalTracerName(code, undefined)).toBe(code);
    });

    it('returns code unchanged when all getTracer calls already use the canonical name', () => {
      const code = "const tracer = trace.getTracer('commit-story');";
      expect(fixCanonicalTracerName(code, canonical)).toBe(code);
    });

    it('returns code unchanged when there are no getTracer calls', () => {
      const code = "async function doWork() { return fetch('https://example.com'); }";
      expect(fixCanonicalTracerName(code, canonical)).toBe(code);
    });
  });

  describe('single-quote literal replaced', () => {
    it('replaces wrong single-quoted tracer name with canonical', () => {
      const code = "const tracer = trace.getTracer('wrong-name');";
      const fixed = fixCanonicalTracerName(code, canonical);
      expect(fixed).toBe("const tracer = trace.getTracer('commit-story');");
    });

    it('preserves surrounding code when replacing single-quoted name', () => {
      const code = [
        "import { trace } from '@opentelemetry/api';",
        "const tracer = trace.getTracer('wrong-name');",
        'async function fetchData() { return 42; }',
      ].join('\n');
      const fixed = fixCanonicalTracerName(code, canonical);
      expect(fixed).toContain("trace.getTracer('commit-story')");
      expect(fixed).toContain("import { trace } from '@opentelemetry/api';");
      expect(fixed).toContain('async function fetchData()');
    });
  });

  describe('double-quote literal replaced', () => {
    it('replaces wrong double-quoted tracer name with canonical', () => {
      const code = 'const tracer = trace.getTracer("wrong-name");';
      const fixed = fixCanonicalTracerName(code, canonical);
      expect(fixed).toBe('const tracer = trace.getTracer("commit-story");');
    });

    it('preserves the double-quote style when replacing', () => {
      const code = 'const tracer = trace.getTracer("commit_story");';
      const fixed = fixCanonicalTracerName(code, canonical);
      expect(fixed).toContain('"commit-story"');
      expect(fixed).not.toContain("'commit-story'");
    });
  });

  describe('template-literal replaced', () => {
    it('replaces wrong backtick tracer name with canonical', () => {
      const code = 'const tracer = trace.getTracer(`wrong-name`);';
      const fixed = fixCanonicalTracerName(code, canonical);
      expect(fixed).toBe('const tracer = trace.getTracer(`commit-story`);');
    });

    it('does not modify interpolated template literals', () => {
      // Interpolated template literals contain `$` and are excluded from the check
      const code = 'const tracer = trace.getTracer(`svc-${env}`);';
      expect(fixCanonicalTracerName(code, canonical)).toBe(code);
    });
  });

  describe('multiple getTracer calls', () => {
    it('replaces all wrong getTracer calls in one pass', () => {
      const code = [
        "const t1 = trace.getTracer('wrong-one');",
        "const t2 = trace.getTracer('wrong-two');",
      ].join('\n');
      const fixed = fixCanonicalTracerName(code, canonical);
      expect(fixed).toBe([
        "const t1 = trace.getTracer('commit-story');",
        "const t2 = trace.getTracer('commit-story');",
      ].join('\n'));
    });

    it('replaces only wrong calls when some already use the canonical name', () => {
      const code = [
        "const t1 = trace.getTracer('commit-story');",
        "const t2 = trace.getTracer('wrong-name');",
      ].join('\n');
      const fixed = fixCanonicalTracerName(code, canonical);
      expect(fixed).toBe([
        "const t1 = trace.getTracer('commit-story');",
        "const t2 = trace.getTracer('commit-story');",
      ].join('\n'));
    });
  });
});

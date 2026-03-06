// ABOUTME: Unit tests for coordinator dispatch module — already-instrumented detection.
// ABOUTME: Covers OTel import detection, span call detection, skipped FileResult creation, and false-positive avoidance.

import { describe, it, expect } from 'vitest';
import { isAlreadyInstrumented, buildSkippedResult } from '../../src/coordinator/dispatch.ts';

describe('isAlreadyInstrumented', () => {
  describe('detects @opentelemetry/api imports', () => {
    it('detects ES module import of @opentelemetry/api', () => {
      const code = `import { trace } from '@opentelemetry/api';\nconsole.log('hello');`;
      expect(isAlreadyInstrumented(code)).toBe(true);
    });

    it('detects CommonJS require of @opentelemetry/api', () => {
      const code = `const { trace } = require('@opentelemetry/api');\nconsole.log('hello');`;
      expect(isAlreadyInstrumented(code)).toBe(true);
    });

    it('detects double-quoted import of @opentelemetry/api', () => {
      const code = `import { trace } from "@opentelemetry/api";\nconsole.log('hello');`;
      expect(isAlreadyInstrumented(code)).toBe(true);
    });

    it('detects @opentelemetry/api in a multi-line import', () => {
      const code = `import {\n  trace,\n  context\n} from '@opentelemetry/api';\n`;
      expect(isAlreadyInstrumented(code)).toBe(true);
    });
  });

  describe('detects tracer span calls', () => {
    it('detects tracer.startActiveSpan calls', () => {
      const code = `function handle(req) {\n  tracer.startActiveSpan('handle', (span) => {\n  });\n}`;
      expect(isAlreadyInstrumented(code)).toBe(true);
    });

    it('detects tracer.startSpan calls', () => {
      const code = `function handle(req) {\n  const span = tracer.startSpan('handle');\n}`;
      expect(isAlreadyInstrumented(code)).toBe(true);
    });

    it('detects .startActiveSpan on any variable name', () => {
      const code = `function handle(req) {\n  myTracer.startActiveSpan('handle', (span) => {\n  });\n}`;
      expect(isAlreadyInstrumented(code)).toBe(true);
    });

    it('detects .startSpan on any variable name', () => {
      const code = `function handle(req) {\n  this._tracer.startSpan('handle');\n}`;
      expect(isAlreadyInstrumented(code)).toBe(true);
    });
  });

  describe('does not falsely skip clean files', () => {
    it('returns false for a plain JavaScript file', () => {
      const code = `function hello() {\n  console.log('hello world');\n}\nmodule.exports = { hello };`;
      expect(isAlreadyInstrumented(code)).toBe(false);
    });

    it('returns false for a file with unrelated imports', () => {
      const code = `import express from 'express';\nconst app = express();\napp.listen(3000);`;
      expect(isAlreadyInstrumented(code)).toBe(false);
    });

    it('returns false for a file mentioning opentelemetry in a comment', () => {
      const code = `// TODO: add @opentelemetry/api instrumentation\nfunction handle() {}`;
      // Comments mentioning OTel are not imports — should not trigger detection
      expect(isAlreadyInstrumented(code)).toBe(false);
    });

    it('returns false for a file with "span" in unrelated context', () => {
      const code = `const timeSpan = calculateTimeSpan(start, end);\nconsole.log(timeSpan);`;
      expect(isAlreadyInstrumented(code)).toBe(false);
    });

    it('returns false for an empty file', () => {
      expect(isAlreadyInstrumented('')).toBe(false);
    });
  });
});

describe('buildSkippedResult', () => {
  it('returns a FileResult with status "skipped"', () => {
    const result = buildSkippedResult('/path/to/file.js');
    expect(result.status).toBe('skipped');
  });

  it('sets the correct file path', () => {
    const result = buildSkippedResult('/project/src/app.js');
    expect(result.path).toBe('/project/src/app.js');
  });

  it('sets zero spans and no libraries', () => {
    const result = buildSkippedResult('/path/to/file.js');
    expect(result.spansAdded).toBe(0);
    expect(result.librariesNeeded).toEqual([]);
    expect(result.schemaExtensions).toEqual([]);
    expect(result.attributesCreated).toBe(0);
  });

  it('sets zero validation attempts and initial-generation strategy', () => {
    const result = buildSkippedResult('/path/to/file.js');
    expect(result.validationAttempts).toBe(0);
    expect(result.validationStrategyUsed).toBe('initial-generation');
  });

  it('sets zero token usage', () => {
    const result = buildSkippedResult('/path/to/file.js');
    expect(result.tokenUsage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    });
  });

  it('includes a reason explaining why the file was skipped', () => {
    const result = buildSkippedResult('/path/to/file.js');
    expect(result.reason).toBeDefined();
    expect(result.reason).toMatch(/already.*instrumented/i);
  });

  it('sets errorProgression and notes to empty arrays', () => {
    const result = buildSkippedResult('/path/to/file.js');
    expect(result.errorProgression).toEqual([]);
    expect(result.notes).toEqual([]);
  });
});

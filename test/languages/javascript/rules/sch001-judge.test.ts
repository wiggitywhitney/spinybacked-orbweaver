// ABOUTME: Tests for SCH-001 extension acceptance judge path — semantic duplicate detection.
// ABOUTME: Verifies judge catches span extensions that are semantic duplicates of registry operations.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../src/validation/judge.ts', () => ({
  callJudge: vi.fn(),
}));
import { callJudge } from '../../../../src/validation/judge.ts';
import type { TokenUsage } from '../../../../src/agent/schema.ts';

import { checkSpanNamesMatchRegistry } from '../../../../src/languages/javascript/rules/sch001.ts';

const MOCK_TOKEN_USAGE: TokenUsage = {
  inputTokens: 80,
  outputTokens: 30,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
};

const filePath = '/tmp/test-file.js';

// Schema with one span definition: "user.register" operation
const schemaWithUserRegister = {
  groups: [
    {
      id: 'span.user.register',
      type: 'span',
      brief: 'Registers a new user account',
    },
  ],
};

// Code that uses "user.registration" as a declared extension (not in registry)
// The agent declares "user.registration" (in the extensions list), then uses it in code.
const codeWithUserRegistration = [
  'const { trace } = require("@opentelemetry/api");',
  'const tracer = trace.getTracer("svc");',
  'function register() {',
  '  return tracer.startActiveSpan("user.registration", (span) => {',
  '    try { return {}; } finally { span.end(); }',
  '  });',
  '}',
].join('\n');

beforeEach(() => {
  vi.mocked(callJudge).mockReset();
});

describe('SCH-001 extension acceptance judge path', () => {
  describe('M5 fixture: declared extension flagged as semantic duplicate', () => {
    it('flags user.registration as semantic duplicate of user.register via judge', async () => {
      // Normalization: "userregistration" vs "userregister" — NOT equal → normalization misses it
      // No Jaccard (span names, useJaccard: false)
      // Judge: returns answer=false (not semantically distinct) → duplicate
      vi.mocked(callJudge).mockResolvedValueOnce({
        verdict: {
          answer: false,
          suggestion: 'Use "user.register" instead.',
          confidence: 0.9,
        },
        tokenUsage: MOCK_TOKEN_USAGE,
      });

      const declaredExtensions = ['span.user.registration'];

      const { results, judgeTokenUsage } = await checkSpanNamesMatchRegistry(
        codeWithUserRegistration, filePath, schemaWithUserRegister,
        { client: {} as any }, declaredExtensions,
      );

      // Extension was flagged as a potential semantic duplicate — advisory, not blocking
      const extensionWarning = results.find(
        (r) => !r.passed && r.message.includes('user.registration'),
      );
      expect(extensionWarning).toBeDefined();
      expect(extensionWarning!.message).toContain('user.register');
      expect(extensionWarning!.blocking).toBe(false);
      expect(judgeTokenUsage).toHaveLength(1);
    });

    it('accepts the span name as valid despite semantic duplicate advisory', async () => {
      // The agent declared "user.registration" which is a semantic duplicate of "user.register".
      // Even with the advisory warning, the span should be accepted so it passes the registry
      // conformance check — without this, the agent oscillates: it cannot use the registry name
      // (different operation) and cannot extend without being blocked.
      vi.mocked(callJudge).mockResolvedValueOnce({
        verdict: {
          answer: false,
          suggestion: 'Use "user.register" instead.',
          confidence: 0.9,
        },
        tokenUsage: MOCK_TOKEN_USAGE,
      });

      const declaredExtensions = ['span.user.registration'];

      const { results } = await checkSpanNamesMatchRegistry(
        codeWithUserRegistration, filePath, schemaWithUserRegister,
        { client: {} as any }, declaredExtensions,
      );

      // The span name "user.registration" in code is accepted (no blocking registry-conformance failure)
      const conformanceFailure = results.find(
        (r) => !r.passed && r.blocking,
      );
      expect(conformanceFailure).toBeUndefined();
    });
  });

  describe('normalization catches delimiter variants without judge', () => {
    // "user_register" normalizes to "userregister" — same as "user.register" → normalization catches
    const codeWithUnderscoreVariant = [
      'const { trace } = require("@opentelemetry/api");',
      'const tracer = trace.getTracer("svc");',
      'function register() {',
      '  return tracer.startActiveSpan("user_register", (span) => {',
      '    try { return {}; } finally { span.end(); }',
      '  });',
      '}',
    ].join('\n');

    it('flags user_register as delimiter-variant of user.register without judge call', async () => {
      const { results, judgeTokenUsage } = await checkSpanNamesMatchRegistry(
        codeWithUnderscoreVariant, filePath, schemaWithUserRegister,
        { client: {} as any }, ['span.user_register'],
      );

      const extensionFailure = results.find(
        (r) => !r.passed && r.message.includes('user_register'),
      );
      expect(extensionFailure).toBeDefined();
      expect(extensionFailure!.message).toContain('delimiter-variant');
      expect(extensionFailure!.message).toContain('user.register');
      // Delimiter variants are blocking — unambiguously wrong, not a judgment call
      expect(extensionFailure!.blocking).toBe(true);
      // Normalization doesn't require judge
      expect(vi.mocked(callJudge)).not.toHaveBeenCalled();
      expect(judgeTokenUsage).toHaveLength(0);
    });

    it('rejects the span name in code when its declared extension is a delimiter variant', async () => {
      // Delimiter variants must not be added to validOperations — the span name in code
      // should still fail the registry conformance check.
      const { results } = await checkSpanNamesMatchRegistry(
        codeWithUnderscoreVariant, filePath, schemaWithUserRegister,
        { client: {} as any }, ['span.user_register'],
      );

      // A blocking conformance failure should appear for "user_register" in code
      const conformanceFailure = results.find(
        (r) => !r.passed && r.blocking && r.message.includes('user_register'),
      );
      expect(conformanceFailure).toBeDefined();
    });
  });

  describe('M5 fixture: genuinely novel extension is accepted', () => {
    it('accepts a genuinely novel span extension not semantically equivalent to registry', async () => {
      vi.mocked(callJudge).mockResolvedValueOnce({
        verdict: {
          answer: true, // semantically distinct
          suggestion: undefined,
          confidence: 0.95,
        },
        tokenUsage: MOCK_TOKEN_USAGE,
      });

      const codeWithNovelExtension = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function purchase() {',
        '  return tracer.startActiveSpan("user.purchase", (span) => {',
        '    try { return {}; } finally { span.end(); }',
        '  });',
        '}',
      ].join('\n');

      const { results } = await checkSpanNamesMatchRegistry(
        codeWithNovelExtension, filePath, schemaWithUserRegister,
        { client: {} as any }, ['span.user.purchase'],
      );

      // Extension accepted — no duplicate failure for "user.purchase"
      const duplicateFailure = results.find(
        (r) => !r.passed && r.message.includes('duplicate'),
      );
      expect(duplicateFailure).toBeUndefined();
    });
  });

  describe('degradation without judge client', () => {
    it('accepts extension without judge when no client provided (normalization-only mode)', async () => {
      // "user.registration" vs "user.register": normalization doesn't catch it
      // No judge → extension accepted (novel)
      const { results } = await checkSpanNamesMatchRegistry(
        codeWithUserRegistration, filePath, schemaWithUserRegister,
        undefined, // no judgeDeps
        ['span.user.registration'],
      );

      // Without judge, semantic duplicate is not caught — extension is accepted
      const extensionFailure = results.find(
        (r) => !r.passed && r.message.includes('duplicate'),
      );
      expect(extensionFailure).toBeUndefined();
      expect(vi.mocked(callJudge)).not.toHaveBeenCalled();
    });
  });

  describe('judge is NOT called for naming quality fallback (deterministic in M5)', () => {
    it('flags single-component span name without calling judge', async () => {
      // Even with a judge client, naming quality is deterministic — no judge call
      const schemaWithoutSpans = { groups: [] };

      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function doWork() {',
        '  return tracer.startActiveSpan("doStuff", (span) => {',
        '    try { return 1; } finally { span.end(); }',
        '  });',
        '}',
      ].join('\n');

      const { results, judgeTokenUsage } = await checkSpanNamesMatchRegistry(
        code, filePath, schemaWithoutSpans, { client: {} as any },
      );

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
      expect(results[0].message).toContain('single-component');
      // Judge is NOT called — naming quality is deterministic
      expect(vi.mocked(callJudge)).not.toHaveBeenCalled();
      expect(judgeTokenUsage).toHaveLength(0);
    });
  });

  describe('judge is NOT called in registry conformance mode for matching span names', () => {
    it('does not call judge when span name exactly matches registry', async () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function register() {',
        '  return tracer.startActiveSpan("user.register", (span) => {',
        '    try { return {}; } finally { span.end(); }',
        '  });',
        '}',
      ].join('\n');

      await checkSpanNamesMatchRegistry(
        code, filePath, schemaWithUserRegister, { client: {} as any },
      );

      expect(vi.mocked(callJudge)).not.toHaveBeenCalled();
    });
  });
});

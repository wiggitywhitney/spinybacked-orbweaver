// ABOUTME: Tests for the shared semantic duplicate detection algorithm used by SCH-001 and SCH-002.
// ABOUTME: Covers normalization, Jaccard similarity, type compatibility, and the three-stage pipeline.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../src/validation/judge.ts', () => ({
  callJudge: vi.fn(),
}));
import { callJudge } from '../../../../src/validation/judge.ts';
import type { TokenUsage } from '../../../../src/agent/schema.ts';

import {
  normalizeKey,
  computeJaccardSimilarity,
  isTypeCompatible,
  checkSemanticDuplicate,
} from '../../../../src/languages/javascript/rules/semantic-dedup.ts';
import type { RegistryEntry, SemanticDedupOptions } from '../../../../src/languages/javascript/rules/semantic-dedup.ts';

const MOCK_TOKEN_USAGE: TokenUsage = {
  inputTokens: 100,
  outputTokens: 20,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
};

// ---------------------------------------------------------------------------
// normalizeKey
// ---------------------------------------------------------------------------

describe('normalizeKey', () => {
  it('lowercases the input', () => {
    expect(normalizeKey('HTTP')).toBe('http');
    expect(normalizeKey('HttpRequest')).toBe('httprequest');
  });

  it('strips dots', () => {
    expect(normalizeKey('http.request.duration')).toBe('httprequestduration');
  });

  it('strips underscores', () => {
    expect(normalizeKey('http_request_duration')).toBe('httprequestduration');
  });

  it('strips hyphens', () => {
    expect(normalizeKey('http-request-duration')).toBe('httprequestduration');
  });

  it('dot and underscore variant normalize to the same string', () => {
    expect(normalizeKey('http.request.duration')).toBe(normalizeKey('http_request_duration'));
  });

  it('mixed delimiters normalize consistently', () => {
    expect(normalizeKey('user.register')).toBe('userregister');
    expect(normalizeKey('user_register')).toBe('userregister');
    expect(normalizeKey('user-register')).toBe('userregister');
  });

  it('empty string returns empty string', () => {
    expect(normalizeKey('')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// computeJaccardSimilarity
// ---------------------------------------------------------------------------

describe('computeJaccardSimilarity', () => {
  it('returns 1.0 for identical names', () => {
    expect(computeJaccardSimilarity('http.request.duration', 'http.request.duration')).toBe(1);
  });

  it('returns 0 for completely disjoint names', () => {
    expect(computeJaccardSimilarity('user.id', 'request.duration')).toBe(0);
  });

  it('returns partial overlap for structurally similar attribute keys', () => {
    // "http.request.duration" tokens: {http, request, duration}
    // "http.response.status_code" tokens: {http, response, status, code}
    // intersection: {http} → 1
    // union: {http, request, duration, response, status, code} → 6
    const sim = computeJaccardSimilarity('http.request.duration', 'http.response.status_code');
    expect(sim).toBeCloseTo(1 / 6, 5);
  });

  it('returns > 0.5 for high token overlap pairs (Jaccard threshold check)', () => {
    // "http.request.status_code" tokens: {http, request, status, code}
    // "http.response.status_code" tokens: {http, response, status, code}
    // intersection: {http, status, code} → 3
    // union: {http, request, status, code, response} → 5
    const sim = computeJaccardSimilarity('http.request.status_code', 'http.response.status_code');
    expect(sim).toBeGreaterThan(0.5);
  });

  it('handles underscore-delimited vs dot-delimited pairs (tokenizes the same)', () => {
    // After tokenizing: both give {http, request, duration}
    const sim = computeJaccardSimilarity('http_request_duration', 'http.request.duration');
    expect(sim).toBe(1);
  });

  it('returns 0 for two empty strings', () => {
    expect(computeJaccardSimilarity('', '')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// isTypeCompatible
// ---------------------------------------------------------------------------

describe('isTypeCompatible', () => {
  it('unknown is always compatible', () => {
    expect(isTypeCompatible('unknown', 'string')).toBe(true);
    expect(isTypeCompatible('unknown', 'int')).toBe(true);
    expect(isTypeCompatible('unknown', undefined)).toBe(true);
  });

  it('absent registry type is always compatible', () => {
    expect(isTypeCompatible('string', undefined)).toBe(true);
    expect(isTypeCompatible('int', undefined)).toBe(true);
  });

  it('matching types are compatible', () => {
    expect(isTypeCompatible('string', 'string')).toBe(true);
    expect(isTypeCompatible('boolean', 'boolean')).toBe(true);
  });

  it('int and double are mutually compatible', () => {
    expect(isTypeCompatible('int', 'double')).toBe(true);
    expect(isTypeCompatible('double', 'int')).toBe(true);
  });

  it('string is not compatible with int', () => {
    expect(isTypeCompatible('string', 'int')).toBe(false);
  });

  it('boolean is not compatible with string', () => {
    expect(isTypeCompatible('boolean', 'string')).toBe(false);
  });

  it('int is not compatible with string', () => {
    expect(isTypeCompatible('int', 'string')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// checkSemanticDuplicate — stage 1: normalization
// ---------------------------------------------------------------------------

describe('checkSemanticDuplicate — normalization stage', () => {
  const baseOptions: SemanticDedupOptions = {
    ruleId: 'SCH-002',
    useJaccard: false,
  };

  it('flags delimiter-variant duplicate (underscore vs dot)', async () => {
    const entries: RegistryEntry[] = [{ name: 'http.request.duration', type: 'double' }];
    const result = await checkSemanticDuplicate('http_request_duration', entries, baseOptions);

    expect(result.isDuplicate).toBe(true);
    expect(result.matchedEntry).toBe('http.request.duration');
    expect(result.detectionMethod).toBe('normalization');
    expect(result.judgeTokenUsage).toHaveLength(0);
  });

  it('flags delimiter-variant duplicate (dot vs hyphen)', async () => {
    const entries: RegistryEntry[] = [{ name: 'http.request.duration' }];
    const result = await checkSemanticDuplicate('http-request-duration', entries, baseOptions);

    expect(result.isDuplicate).toBe(true);
    expect(result.detectionMethod).toBe('normalization');
  });

  it('does not call the judge when normalization catches the duplicate', async () => {
    const entries: RegistryEntry[] = [{ name: 'http.request.duration' }];
    await checkSemanticDuplicate('http_request_duration', entries, {
      ...baseOptions,
      judgeDeps: { client: {} as any },
    });

    expect(vi.mocked(callJudge)).not.toHaveBeenCalled();
  });

  it('returns no match for genuinely different names', async () => {
    const entries: RegistryEntry[] = [{ name: 'http.request.duration' }];
    const result = await checkSemanticDuplicate('user.login.count', entries, baseOptions);

    expect(result.isDuplicate).toBe(false);
    expect(result.matchedEntry).toBeUndefined();
  });

  it('returns no match for empty registry', async () => {
    const result = await checkSemanticDuplicate('http_request_duration', [], baseOptions);
    expect(result.isDuplicate).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// checkSemanticDuplicate — stage 2: Jaccard pre-pass (SCH-002 mode)
// ---------------------------------------------------------------------------

describe('checkSemanticDuplicate — Jaccard stage', () => {
  beforeEach(() => {
    vi.mocked(callJudge).mockReset();
  });

  it('flags high-overlap pair via Jaccard when useJaccard is true', async () => {
    // http.request.status_code vs http.response.status_code: overlap {http, status, code} / union 5 = 0.6
    const entries: RegistryEntry[] = [{ name: 'http.response.status_code', type: 'int' }];
    const result = await checkSemanticDuplicate('http.request.status_code', entries, {
      ruleId: 'SCH-002',
      useJaccard: true,
    });

    expect(result.isDuplicate).toBe(true);
    expect(result.matchedEntry).toBe('http.response.status_code');
    expect(result.detectionMethod).toBe('jaccard');
    expect(result.judgeTokenUsage).toHaveLength(0);
  });

  it('does not flag low-overlap pair via Jaccard', async () => {
    const entries: RegistryEntry[] = [{ name: 'user.login.timestamp', type: 'string' }];
    const result = await checkSemanticDuplicate('http.request.duration', entries, {
      ruleId: 'SCH-002',
      useJaccard: true,
    });

    expect(result.isDuplicate).toBe(false);
  });

  it('type-compat pre-filter prevents Jaccard from flagging type-mismatched pairs', async () => {
    // user_age_label vs user.age (int): Jaccard = 2/3 = 0.67 > 0.5, would normally flag
    // but string (candidate) vs int (registry) are incompatible → user.age excluded before Jaccard
    const entries: RegistryEntry[] = [{ name: 'user.age', type: 'int' }];
    const result = await checkSemanticDuplicate('user_age_label', entries, {
      ruleId: 'SCH-002',
      useJaccard: true,
      inferredType: 'string',
    });

    expect(result.isDuplicate).toBe(false);
  });

  it('skips Jaccard stage when useJaccard is false (SCH-001 mode)', async () => {
    // Same pair as the Jaccard test above — should NOT be caught without Jaccard
    const entries: RegistryEntry[] = [{ name: 'http.response.status_code' }];
    const result = await checkSemanticDuplicate('http.request.status_code', entries, {
      ruleId: 'SCH-001',
      useJaccard: false,
    });

    // Without Jaccard enabled, this pair falls through to the judge (or passes if no judge)
    expect(result.detectionMethod).not.toBe('jaccard');
  });

  it('does not call the judge when Jaccard catches the duplicate', async () => {
    const entries: RegistryEntry[] = [{ name: 'http.response.status_code' }];
    await checkSemanticDuplicate('http.request.status_code', entries, {
      ruleId: 'SCH-002',
      useJaccard: true,
      judgeDeps: { client: {} as any },
    });

    expect(vi.mocked(callJudge)).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// checkSemanticDuplicate — stage 3: judge
// ---------------------------------------------------------------------------

describe('checkSemanticDuplicate — judge stage', () => {
  beforeEach(() => {
    vi.mocked(callJudge).mockReset();
  });

  it('flags semantic duplicate when judge says not distinct (SCH-001 mode — no pre-filters)', async () => {
    // user.register vs user_registration — normalization doesn't catch (different length),
    // no Jaccard in SCH-001. Judge says they are semantic duplicates.
    vi.mocked(callJudge).mockResolvedValueOnce({
      verdict: { answer: false, suggestion: 'Use "user.register" instead.', confidence: 0.9 },
      tokenUsage: MOCK_TOKEN_USAGE,
    });

    const entries: RegistryEntry[] = [{ name: 'user.register' }];
    const result = await checkSemanticDuplicate('user_registration', entries, {
      ruleId: 'SCH-001',
      useJaccard: false,
      judgeDeps: { client: {} as any },
    });

    expect(result.isDuplicate).toBe(true);
    expect(result.matchedEntry).toBe('user.register');
    expect(result.detectionMethod).toBe('judge');
    expect(result.judgeTokenUsage).toHaveLength(1);
  });

  it('passes a genuinely novel extension that judge confirms is distinct', async () => {
    vi.mocked(callJudge).mockResolvedValueOnce({
      verdict: { answer: true, suggestion: undefined, confidence: 0.95 },
      tokenUsage: MOCK_TOKEN_USAGE,
    });

    const entries: RegistryEntry[] = [
      { name: 'user.register' },
      { name: 'user.login' },
    ];
    const result = await checkSemanticDuplicate('user.purchase', entries, {
      ruleId: 'SCH-001',
      useJaccard: false,
      judgeDeps: { client: {} as any },
    });

    expect(result.isDuplicate).toBe(false);
    expect(result.judgeTokenUsage).toHaveLength(1);
  });

  it('ignores judge verdict below confidence threshold (< 0.7)', async () => {
    vi.mocked(callJudge).mockResolvedValueOnce({
      verdict: { answer: false, suggestion: 'Use "user.register".', confidence: 0.5 },
      tokenUsage: MOCK_TOKEN_USAGE,
    });

    const entries: RegistryEntry[] = [{ name: 'user.register' }];
    const result = await checkSemanticDuplicate('user_registration', entries, {
      ruleId: 'SCH-001',
      useJaccard: false,
      judgeDeps: { client: {} as any },
    });

    expect(result.isDuplicate).toBe(false);
    expect(result.judgeTokenUsage).toHaveLength(1);
  });

  it('returns no match gracefully when judge call fails (returns null)', async () => {
    vi.mocked(callJudge).mockResolvedValueOnce(null);

    const entries: RegistryEntry[] = [{ name: 'user.register' }];
    const result = await checkSemanticDuplicate('user_registration', entries, {
      ruleId: 'SCH-001',
      useJaccard: false,
      judgeDeps: { client: {} as any },
    });

    expect(result.isDuplicate).toBe(false);
    expect(result.judgeTokenUsage).toHaveLength(0);
  });

  it('returns token usage even when judge verdict is null (parse failure)', async () => {
    vi.mocked(callJudge).mockResolvedValueOnce({
      verdict: null,
      tokenUsage: MOCK_TOKEN_USAGE,
    });

    const entries: RegistryEntry[] = [{ name: 'user.register' }];
    const result = await checkSemanticDuplicate('user_registration', entries, {
      ruleId: 'SCH-001',
      useJaccard: false,
      judgeDeps: { client: {} as any },
    });

    expect(result.isDuplicate).toBe(false);
    expect(result.judgeTokenUsage).toHaveLength(1);
  });

  it('applies namespace pre-filter for SCH-002 (inferredType provided)', async () => {
    // Candidate "commit.story.chapters" — root namespace "commit"
    // Registry has entries from "commit" and "gen_ai" namespaces
    // Only "commit.*" entries should be passed to the judge
    vi.mocked(callJudge).mockResolvedValueOnce({
      verdict: { answer: true, suggestion: undefined, confidence: 0.95 },
      tokenUsage: MOCK_TOKEN_USAGE,
    });

    const entries: RegistryEntry[] = [
      { name: 'commit.story.summary', type: 'string' },
      { name: 'gen_ai.usage.output_tokens', type: 'int' },
    ];

    await checkSemanticDuplicate('commit.story.chapters', entries, {
      ruleId: 'SCH-002',
      useJaccard: false,
      inferredType: 'string',
      judgeDeps: { client: {} as any },
    });

    expect(vi.mocked(callJudge)).toHaveBeenCalledOnce();
    const [question] = vi.mocked(callJudge).mock.calls[0]!;
    expect(question.candidates).toContain('commit.story.summary');
    expect(question.candidates).not.toContain('gen_ai.usage.output_tokens');
  });

  it('applies type-compatibility pre-filter for SCH-002 (excludes incompatible types)', async () => {
    // Agent declares an int attribute — string entries should be excluded from judge candidates
    vi.mocked(callJudge).mockResolvedValueOnce({
      verdict: { answer: true, suggestion: undefined, confidence: 0.9 },
      tokenUsage: MOCK_TOKEN_USAGE,
    });

    const entries: RegistryEntry[] = [
      { name: 'user.age', type: 'string' },    // incompatible — string vs int
      { name: 'user.count', type: 'int' },      // compatible
    ];

    await checkSemanticDuplicate('user.total', entries, {
      ruleId: 'SCH-002',
      useJaccard: false,
      inferredType: 'int',
      judgeDeps: { client: {} as any },
    });

    const [question] = vi.mocked(callJudge).mock.calls[0]!;
    expect(question.candidates).not.toContain('user.age');
    expect(question.candidates).toContain('user.count');
  });

  it('skips judge entirely when all candidates are filtered out by pre-filters', async () => {
    // All registry entries are in a different namespace — judge is skipped entirely
    const entries: RegistryEntry[] = [
      { name: 'gen_ai.tokens.used', type: 'int' },
    ];

    const result = await checkSemanticDuplicate('commit.story.count', entries, {
      ruleId: 'SCH-002',
      useJaccard: false,
      inferredType: 'int',
      judgeDeps: { client: {} as any },
    });

    expect(vi.mocked(callJudge)).not.toHaveBeenCalled();
    expect(result.isDuplicate).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// checkSemanticDuplicate — optional-client-absent degradation
// ---------------------------------------------------------------------------

describe('checkSemanticDuplicate — no judgeDeps (degraded mode)', () => {
  beforeEach(() => {
    vi.mocked(callJudge).mockReset();
  });

  it('catches delimiter-variant duplicates via normalization without a judge', async () => {
    const entries: RegistryEntry[] = [{ name: 'http.request.duration' }];
    const result = await checkSemanticDuplicate('http_request_duration', entries, {
      ruleId: 'SCH-002',
      useJaccard: true,
      // no judgeDeps
    });

    expect(result.isDuplicate).toBe(true);
    expect(result.detectionMethod).toBe('normalization');
  });

  it('does not flag semantic duplicates that require the judge when no client provided', async () => {
    // "user_registration" vs "user.register" — normalization doesn't catch (different lengths)
    // Without judge, these pass
    const entries: RegistryEntry[] = [{ name: 'user.register' }];
    const result = await checkSemanticDuplicate('user_registration', entries, {
      ruleId: 'SCH-001',
      useJaccard: false,
      // no judgeDeps
    });

    expect(result.isDuplicate).toBe(false);
    expect(vi.mocked(callJudge)).not.toHaveBeenCalled();
  });

  it('does not flag Jaccard-detected duplicates when useJaccard is false and no judge', async () => {
    const entries: RegistryEntry[] = [{ name: 'http.response.status_code' }];
    const result = await checkSemanticDuplicate('http.request.status_code', entries, {
      ruleId: 'SCH-001',
      useJaccard: false,
      // no judgeDeps
    });

    expect(result.isDuplicate).toBe(false);
    expect(vi.mocked(callJudge)).not.toHaveBeenCalled();
  });
});

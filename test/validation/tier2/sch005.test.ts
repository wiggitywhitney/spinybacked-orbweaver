// ABOUTME: Tests for SCH-005 registry span deduplication check.
// ABOUTME: Covers extractSpanDefinitions, graceful degradation, and LLM judge tier.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/validation/judge.ts', () => ({
  callJudge: vi.fn(),
}));
import { callJudge } from '../../../src/validation/judge.ts';
import type { TokenUsage } from '../../../src/agent/schema.ts';

import { extractSpanDefinitions, checkRegistrySpanDuplicates, sch005Rule } from '../../../src/validation/tier2/sch005.ts';

// Fixture resolved registry with 3 span definitions and 2 attribute definitions
const FIXTURE_REGISTRY_MIXED = {
  groups: [
    { id: 'span.myapp.api.handle_request', type: 'span', brief: 'Handles an incoming API request' },
    { id: 'span.myapp.db.query', type: 'span', brief: 'Executes a database query' },
    { id: 'span.myapp.cache.get', type: 'span' }, // no brief
    { id: 'registry.myapp.request.id', type: 'attribute_group', brief: 'Request identifier' },
    { id: 'registry.myapp.user.id', type: 'attribute_group' },
  ],
};

const FIXTURE_REGISTRY_SPANS_ONLY = {
  groups: [
    { id: 'span.svc.op_a', type: 'span', brief: 'Operation A' },
    { id: 'span.svc.op_b', type: 'span' },
  ],
};

const FIXTURE_REGISTRY_NO_SPANS = {
  groups: [
    { id: 'registry.myapp.attr.one', type: 'attribute_group' },
    { id: 'registry.myapp.attr.two', type: 'attribute_group' },
  ],
};

const FIXTURE_REGISTRY_EMPTY: { groups: unknown[] } = { groups: [] };

describe('extractSpanDefinitions', () => {
  it('returns exactly the span definitions from a mixed registry (3 spans, 2 attributes → 3 items)', () => {
    const result = extractSpanDefinitions(FIXTURE_REGISTRY_MIXED);
    expect(result).toHaveLength(3);
  });

  it('includes span IDs in the result', () => {
    const result = extractSpanDefinitions(FIXTURE_REGISTRY_MIXED);
    const ids = result.map(s => s.id);
    expect(ids).toContain('span.myapp.api.handle_request');
    expect(ids).toContain('span.myapp.db.query');
    expect(ids).toContain('span.myapp.cache.get');
  });

  it('includes brief when present', () => {
    const result = extractSpanDefinitions(FIXTURE_REGISTRY_MIXED);
    const req = result.find(s => s.id === 'span.myapp.api.handle_request');
    expect(req?.brief).toBe('Handles an incoming API request');
  });

  it('omits brief when absent', () => {
    const result = extractSpanDefinitions(FIXTURE_REGISTRY_MIXED);
    const cache = result.find(s => s.id === 'span.myapp.cache.get');
    expect(cache?.brief).toBeUndefined();
  });

  it('does not include attribute group entries', () => {
    const result = extractSpanDefinitions(FIXTURE_REGISTRY_MIXED);
    const ids = result.map(s => s.id);
    expect(ids).not.toContain('registry.myapp.request.id');
    expect(ids).not.toContain('registry.myapp.user.id');
  });

  it('returns all spans when registry has no attribute groups', () => {
    const result = extractSpanDefinitions(FIXTURE_REGISTRY_SPANS_ONLY);
    expect(result).toHaveLength(2);
  });

  it('returns empty array when registry has no span definitions', () => {
    const result = extractSpanDefinitions(FIXTURE_REGISTRY_NO_SPANS);
    expect(result).toHaveLength(0);
  });

  it('returns empty array for an empty registry', () => {
    const result = extractSpanDefinitions(FIXTURE_REGISTRY_EMPTY);
    expect(result).toHaveLength(0);
  });

  it('returns empty array for a malformed input', () => {
    const result = extractSpanDefinitions({});
    expect(result).toHaveLength(0);
  });

  it('includes span_kind when present on a registry group', () => {
    const registry = {
      groups: [
        { id: 'span.myapp.api.request', type: 'span', span_kind: 'SERVER' },
        { id: 'span.myapp.db.query', type: 'span' },
      ],
    };
    const result = extractSpanDefinitions(registry);
    const server = result.find((s) => s.id === 'span.myapp.api.request');
    const db = result.find((s) => s.id === 'span.myapp.db.query');
    expect(server?.span_kind).toBe('SERVER');
    expect(db?.span_kind).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Fixtures for checkRegistrySpanDuplicates
// ---------------------------------------------------------------------------

// Same root namespace pair — both in "billing" namespace
const REGISTRY_SAME_NS_GAP_PAIR = {
  groups: [
    { id: 'span.billing.process.payment', type: 'span', brief: 'Processes a payment' },
    { id: 'span.billing.handle.charge', type: 'span', brief: 'Handles a charge' },
  ],
};

// Different root namespace pair — auth vs billing
const REGISTRY_DIFF_NS_GAP_PAIR = {
  groups: [
    { id: 'span.auth.request.handle', type: 'span', brief: 'Handles an auth request' },
    { id: 'span.billing.request.process', type: 'span', brief: 'Processes a billing request' },
  ],
};

// Same namespace, different span_kind — CLIENT vs SERVER
const REGISTRY_DIFF_SPAN_KIND_PAIR = {
  groups: [
    { id: 'span.billing.process.payment', type: 'span', span_kind: 'CLIENT', brief: 'Client-side billing call' },
    { id: 'span.billing.process.payment', type: 'span', span_kind: 'SERVER', brief: 'Server-side billing handler' },
  ],
};

// Same namespace, one span missing span_kind
const REGISTRY_ONE_MISSING_SPAN_KIND = {
  groups: [
    { id: 'span.billing.process.payment', type: 'span', span_kind: 'CLIENT', brief: 'Client-side billing call' },
    { id: 'span.billing.handle.charge', type: 'span', brief: 'Handles a charge' },
  ],
};

describe('checkRegistrySpanDuplicates (SCH-005)', () => {
  const mockTokenUsage: TokenUsage = {
    inputTokens: 100,
    outputTokens: 40,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  };

  beforeEach(() => {
    vi.mocked(callJudge).mockReset();
  });

  it('returns pass for a registry with fewer than two spans', async () => {
    const single = { groups: [{ id: 'span.myapp.api.request', type: 'span' }] };
    const { results } = await checkRegistrySpanDuplicates(single);
    const findings = results.filter((r) => !r.passed);
    expect(findings).toHaveLength(0);
  });

  it('returns pass immediately when no judgeDeps provided (graceful degradation)', async () => {
    const { results, judgeTokenUsage } = await checkRegistrySpanDuplicates(REGISTRY_SAME_NS_GAP_PAIR);
    const findings = results.filter((r) => !r.passed);
    expect(findings).toHaveLength(0);
    expect(results[0]!.passed).toBe(true);
    expect(judgeTokenUsage).toHaveLength(0);
    expect(vi.mocked(callJudge)).not.toHaveBeenCalled();
  });

  it('does not call judge for same-namespace pairs with different span_kind (D-3 pre-filter)', async () => {
    vi.mocked(callJudge).mockResolvedValue({
      verdict: { answer: false, confidence: 0.9 },
      tokenUsage: mockTokenUsage,
    });

    await checkRegistrySpanDuplicates(REGISTRY_DIFF_SPAN_KIND_PAIR, { client: {} as any });

    expect(vi.mocked(callJudge)).not.toHaveBeenCalled();
  });

  it('calls judge normally when one or both spans lack span_kind', async () => {
    vi.mocked(callJudge).mockResolvedValue({
      verdict: { answer: true, confidence: 0.9 },
      tokenUsage: mockTokenUsage,
    });

    await checkRegistrySpanDuplicates(REGISTRY_ONE_MISSING_SPAN_KIND, { client: {} as any });

    expect(vi.mocked(callJudge)).toHaveBeenCalledTimes(1);
  });

  it('does not call judge for pairs with differing root namespaces', async () => {
    // Pre-filter (D-1): pairs from different root namespaces are skipped before the judge call.
    vi.mocked(callJudge).mockResolvedValue({
      verdict: { answer: false, confidence: 0.9 },
      tokenUsage: mockTokenUsage,
    });

    await checkRegistrySpanDuplicates(REGISTRY_DIFF_NS_GAP_PAIR, { client: {} as any });

    expect(vi.mocked(callJudge)).not.toHaveBeenCalled();
  });

  it('calls judge with only namespace-compatible candidates', async () => {
    vi.mocked(callJudge).mockResolvedValue({
      verdict: { answer: true, confidence: 0.9 },
      tokenUsage: mockTokenUsage,
    });

    await checkRegistrySpanDuplicates(REGISTRY_SAME_NS_GAP_PAIR, { client: {} as any });

    expect(vi.mocked(callJudge)).toHaveBeenCalledTimes(1);
    const question = vi.mocked(callJudge).mock.calls[0]![0];
    // candidates contains only the two same-namespace span IDs being evaluated
    expect(question.candidates).toEqual([
      'span.billing.process.payment',
      'span.billing.handle.charge',
    ]);
  });

  it('produces a finding when judge returns false at confidence 0.8 with matching namespaces', async () => {
    vi.mocked(callJudge).mockResolvedValue({
      verdict: { answer: false, confidence: 0.8 },
      tokenUsage: mockTokenUsage,
    });

    const { results, judgeTokenUsage } = await checkRegistrySpanDuplicates(
      REGISTRY_SAME_NS_GAP_PAIR,
      { client: {} as any },
    );

    const findings = results.filter((r) => !r.passed);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.ruleId).toBe('SCH-005');
    expect(findings[0]!.blocking).toBe(false);
    expect(judgeTokenUsage).toHaveLength(1);
  });

  it('produces no finding when differing-namespace pairs are filtered before reaching the judge', async () => {
    // The D-1 pre-filter blocks judge calls for different root namespaces.
    // Even with a false-verdict mock set up, the judge is never invoked,
    // so no finding is emitted. This validates the combined namespace gate.
    vi.mocked(callJudge).mockResolvedValue({
      verdict: { answer: false, confidence: 0.9 },
      tokenUsage: mockTokenUsage,
    });

    const { results } = await checkRegistrySpanDuplicates(REGISTRY_DIFF_NS_GAP_PAIR, {
      client: {} as any,
    });

    const findings = results.filter((r) => !r.passed);
    expect(findings).toHaveLength(0);
    expect(vi.mocked(callJudge)).not.toHaveBeenCalled();
  });

  it('produces no finding when judge returns true (spans are distinct)', async () => {
    vi.mocked(callJudge).mockResolvedValue({
      verdict: { answer: true, confidence: 0.9 },
      tokenUsage: mockTokenUsage,
    });

    const { results } = await checkRegistrySpanDuplicates(REGISTRY_SAME_NS_GAP_PAIR, {
      client: {} as any,
    });

    const findings = results.filter((r) => !r.passed);
    expect(findings).toHaveLength(0);
  });

  it('produces no finding when judge returns null (API failure — skip silently)', async () => {
    vi.mocked(callJudge).mockResolvedValue(null);

    const { results, judgeTokenUsage } = await checkRegistrySpanDuplicates(
      REGISTRY_SAME_NS_GAP_PAIR,
      { client: {} as any },
    );

    const findings = results.filter((r) => !r.passed);
    expect(findings).toHaveLength(0);
    expect(judgeTokenUsage).toHaveLength(0);
  });
});

describe('sch005Rule (per-file stub)', () => {
  it('always passes per-file', () => {
    const input = {
      filePath: '/tmp/test.js',
      originalCode: '',
      instrumentedCode: '',
      config: { enableWeaver: false, tier2Checks: {} },
      language: 'javascript',
      provider: {} as never,
    };
    const result = sch005Rule.check(input);
    // Result is a single CheckResult (not array or Sch005Result)
    const checkResult = Array.isArray(result)
      ? result[0]
      : 'results' in (result as object)
        ? (result as { results: { passed: boolean }[] }).results[0]
        : result as { passed: boolean };
    expect((checkResult as { passed: boolean }).passed).toBe(true);
  });

  it('has ruleId SCH-005', () => {
    expect(sch005Rule.ruleId).toBe('SCH-005');
  });

  it('is non-blocking', () => {
    expect(sch005Rule.blocking).toBe(false);
  });

  it('applies to all languages', () => {
    expect(sch005Rule.applicableTo('javascript')).toBe(true);
    expect(sch005Rule.applicableTo('python')).toBe(true);
    expect(sch005Rule.applicableTo('go')).toBe(true);
  });
});

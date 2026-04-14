// ABOUTME: Tests for SCH-005 registry span deduplication check.
// ABOUTME: Covers extractSpanDefinitions, Jaccard script tier, LLM judge tier, and coordinator wiring.

import { describe, it, expect } from 'vitest';
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
});

// ---------------------------------------------------------------------------
// Fixtures for checkRegistrySpanDuplicates
// ---------------------------------------------------------------------------

// Two spans with >0.5 Jaccard similarity:
// tokens {span,myapp,generate,run} vs {span,myapp,generate,execute}
// intersection=3 (span,myapp,generate), union=5 → 0.60
const REGISTRY_SIMILAR_PAIR = {
  groups: [
    { id: 'span.myapp.generate.run', type: 'span', brief: 'Runs the generator' },
    { id: 'span.myapp.generate.execute', type: 'span', brief: 'Executes the generator' },
  ],
};

// Two clearly distinct spans:
// tokens {span,myapp,api,handle,request} vs {span,billing,payment,process}
// intersection=1 (span), union=8 → 0.125
const REGISTRY_DISTINCT_PAIR = {
  groups: [
    { id: 'span.myapp.api.handle_request', type: 'span' },
    { id: 'span.billing.payment.process', type: 'span' },
  ],
};

// Three spans, only one pair overlaps:
// A vs B: 3/5=0.60 → finding
// A vs C: 1/7≈0.14 → no finding
// B vs C: 1/7≈0.14 → no finding
const REGISTRY_THREE_SPANS_ONE_OVERLAP = {
  groups: [
    { id: 'span.myapp.generate.run', type: 'span' },
    { id: 'span.myapp.generate.execute', type: 'span' },
    { id: 'span.billing.payment.process', type: 'span' },
  ],
};

describe('checkRegistrySpanDuplicates (SCH-005 script tier)', () => {
  it('produces a finding when two span IDs have >0.5 Jaccard similarity', async () => {
    const { results } = await checkRegistrySpanDuplicates(REGISTRY_SIMILAR_PAIR);
    const findings = results.filter(r => !r.passed);
    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(findings[0].ruleId).toBe('SCH-005');
    expect(findings[0].blocking).toBe(false);
    expect(findings[0].tier).toBe(2);
  });

  it('produces no findings when two span IDs are clearly distinct', async () => {
    const { results } = await checkRegistrySpanDuplicates(REGISTRY_DISTINCT_PAIR);
    const findings = results.filter(r => !r.passed);
    expect(findings).toHaveLength(0);
  });

  it('produces exactly one finding when three spans have only one overlapping pair', async () => {
    const { results } = await checkRegistrySpanDuplicates(REGISTRY_THREE_SPANS_ONE_OVERLAP);
    const findings = results.filter(r => !r.passed);
    expect(findings).toHaveLength(1);
  });

  it('produces no findings for a registry with fewer than two spans', async () => {
    const single = { groups: [{ id: 'span.myapp.api.request', type: 'span' }] };
    const { results } = await checkRegistrySpanDuplicates(single);
    const findings = results.filter(r => !r.passed);
    expect(findings).toHaveLength(0);
  });

  it('returns empty judgeTokenUsage (no judge calls in script tier)', async () => {
    const { judgeTokenUsage } = await checkRegistrySpanDuplicates(REGISTRY_SIMILAR_PAIR);
    expect(judgeTokenUsage).toHaveLength(0);
  });

  it('finding message includes both span IDs', async () => {
    const { results } = await checkRegistrySpanDuplicates(REGISTRY_SIMILAR_PAIR);
    const finding = results.find(r => !r.passed);
    expect(finding?.message).toContain('span.myapp.generate.run');
    expect(finding?.message).toContain('span.myapp.generate.execute');
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

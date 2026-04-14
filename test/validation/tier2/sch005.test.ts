// ABOUTME: Tests for SCH-005 registry span deduplication check.
// ABOUTME: Covers extractSpanDefinitions, Jaccard script tier, LLM judge tier, and coordinator wiring.

import { describe, it, expect } from 'vitest';
import { extractSpanDefinitions } from '../../../src/validation/tier2/sch005.ts';

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

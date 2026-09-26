// ABOUTME: Tests for the COV-005 Tier 2 check — Python domain-specific attributes present.
// ABOUTME: Verifies with-scoped and raw start_span() attribute collection against registry definitions.

import { describe, it, expect } from 'vitest';
import { checkPythonDomainAttributes } from '../../../../src/languages/python/rules/cov005.ts';
import type { RegistrySpanDefinition } from '../../../../src/validation/types.ts';

describe('checkPythonDomainAttributes (COV-005)', () => {
  const filePath = '/tmp/test-file.py';

  const registry: RegistrySpanDefinition[] = [{
    spanName: 'create_order',
    requiredAttributes: ['order.id'],
    recommendedAttributes: ['order.total'],
  }];

  describe('no registry definitions', () => {
    it('passes when the registry is empty', () => {
      const code = 'def handler():\n    return 1\n';

      const results = checkPythonDomainAttributes(code, filePath, []);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
      expect(results[0].ruleId).toBe('COV-005');
      expect(results[0].tier).toBe(2);
      expect(results[0].blocking).toBe(false);
    });
  });

  describe('with-scoped span', () => {
    it('flags a with-scoped span missing required and recommended attributes', () => {
      const code = [
        'def create_order(order_id):',
        '    with tracer.start_as_current_span("create_order") as span:',
        '        return order_id',
        '',
      ].join('\n');

      const results = checkPythonDomainAttributes(code, filePath, registry);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
      expect(results[0].ruleId).toBe('COV-005');
      expect(results[0].message).toContain('order.id');
      expect(results[0].message).toContain('order.total');
    });

    it('passes when all required and recommended attributes are set', () => {
      const code = [
        'def create_order(order_id, total):',
        '    with tracer.start_as_current_span("create_order") as span:',
        '        span.set_attribute("order.id", order_id)',
        '        span.set_attribute("order.total", total)',
        '        return order_id',
        '',
      ].join('\n');

      const results = checkPythonDomainAttributes(code, filePath, registry);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('flags only the missing recommended attribute when required is present', () => {
      const code = [
        'def create_order(order_id):',
        '    with tracer.start_as_current_span("create_order") as span:',
        '        span.set_attribute("order.id", order_id)',
        '        return order_id',
        '',
      ].join('\n');

      const results = checkPythonDomainAttributes(code, filePath, registry);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
      expect(results[0].message).toContain('order.total');
      expect(results[0].message).not.toContain('Required (must add): order.id');
    });

    it('does not flag a span with no matching registry definition', () => {
      const code = [
        'def other():',
        '    with tracer.start_as_current_span("other"):',
        '        return 1',
        '',
      ].join('\n');

      const results = checkPythonDomainAttributes(code, filePath, registry);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });
  });

  describe('raw start_span()', () => {
    it('flags a raw start_span() span missing attributes', () => {
      const code = [
        'def create_order(order_id):',
        '    span = tracer.start_span("create_order")',
        '    try:',
        '        return order_id',
        '    finally:',
        '        span.end()',
        '',
      ].join('\n');

      const results = checkPythonDomainAttributes(code, filePath, registry);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
    });

    it('passes when a raw start_span() span has all attributes set before .end()', () => {
      const code = [
        'def create_order(order_id, total):',
        '    span = tracer.start_span("create_order")',
        '    try:',
        '        span.set_attribute("order.id", order_id)',
        '        span.set_attribute("order.total", total)',
        '        return order_id',
        '    finally:',
        '        span.end()',
        '',
      ].join('\n');

      const results = checkPythonDomainAttributes(code, filePath, registry);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });
  });
});

// ABOUTME: Tests for the CDQ-007 Tier 2 check — Python attribute data quality (PII names, path values).
// ABOUTME: The nullable-member-access sub-check is deliberately excluded — see Decision D-CDQ007-1.

import { describe, it, expect } from 'vitest';
import { checkPythonAttributeDataQuality } from '../../../../src/languages/python/rules/cdq007.ts';

describe('checkPythonAttributeDataQuality (CDQ-007)', () => {
  const filePath = '/tmp/test-file.py';

  describe('no data quality issues', () => {
    it('passes for a non-PII, non-path attribute', () => {
      const code = 'span.set_attribute("http.method", "GET")\n';

      const results = checkPythonAttributeDataQuality(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
      expect(results[0].ruleId).toBe('CDQ-007');
      expect(results[0].tier).toBe(2);
      expect(results[0].blocking).toBe(false);
    });
  });

  describe('PII attribute names', () => {
    it('flags an exact PII key match', () => {
      const code = 'span.set_attribute("email", user_email)\n';

      const results = checkPythonAttributeDataQuality(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
      expect(results[0].ruleId).toBe('CDQ-007');
      expect(results[0].message).toContain('PII');
    });

    it('flags a PII suffix in a dotted key', () => {
      const code = 'span.set_attribute("commit.author", author_name)\n';

      const results = checkPythonAttributeDataQuality(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
      expect(results[0].message).toContain('PII');
    });

    it('does not flag "name" as a dotted suffix (legitimate OTel keys)', () => {
      const code = 'span.set_attribute("service.name", "my-service")\n';

      const results = checkPythonAttributeDataQuality(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });
  });

  describe('filesystem path values', () => {
    it('flags a value identifier containing "path"', () => {
      const code = 'span.set_attribute("config.location", config_path)\n';

      const results = checkPythonAttributeDataQuality(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
      expect(results[0].message).toContain('filesystem path');
    });

    it('flags a well-known compound path identifier', () => {
      const code = 'span.set_attribute("config.location", filepath)\n';

      const results = checkPythonAttributeDataQuality(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
    });

    it('does not flag a path-like identifier under an OTel file.* key', () => {
      const code = 'span.set_attribute("file.path", file_path)\n';

      const results = checkPythonAttributeDataQuality(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('does not flag an identifier that merely contains "file" as a substring', () => {
      const code = 'span.set_attribute("profile.id", profile_id)\n';

      const results = checkPythonAttributeDataQuality(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });
  });

  describe('non-span receivers', () => {
    it('does not flag set_attribute on an unrelated object', () => {
      const code = 'config.set_attribute("email", user_email)\n';

      const results = checkPythonAttributeDataQuality(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });
  });
});

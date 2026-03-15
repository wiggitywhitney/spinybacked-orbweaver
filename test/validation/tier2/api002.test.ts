// ABOUTME: Tests for API-002 Tier 2 check — OTel API dependency placement verification.
// ABOUTME: Verifies that @opentelemetry/api is in peerDependencies (library) or dependencies (app).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkOtelApiDependencyPlacement } from '../../../src/validation/tier2/api002.ts';

describe('checkOtelApiDependencyPlacement (API-002)', () => {
  const filePath = '/tmp/test-file.js';
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'api002-test-'));
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  function writePackageJson(content: Record<string, unknown>) {
    writeFileSync(join(projectRoot, 'package.json'), JSON.stringify(content, null, 2));
  }

  describe('library projects (peerDependency required)', () => {
    it('passes when @opentelemetry/api is in peerDependencies', () => {
      writePackageJson({
        name: 'my-lib',
        main: 'dist/index.js',
        peerDependencies: { '@opentelemetry/api': '^1.0.0' },
      });

      const results = checkOtelApiDependencyPlacement(filePath, projectRoot);

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
      expect(results[0].ruleId).toBe('API-002');
    });

    it('fails when @opentelemetry/api is in both dependencies and peerDependencies for a library', () => {
      writePackageJson({
        name: 'my-lib',
        exports: { '.': './src/index.js' },
        dependencies: { '@opentelemetry/api': '^1.0.0' },
        peerDependencies: { '@opentelemetry/api': '^1.0.0' },
      });

      const results = checkOtelApiDependencyPlacement(filePath, projectRoot);
      const failures = results.filter(r => !r.passed);

      expect(failures).toHaveLength(1);
      expect(failures[0].ruleId).toBe('API-002');
      expect(failures[0].message).toContain('both');
    });

    it('fails when @opentelemetry/api is in dependencies (not peerDependencies) for a library', () => {
      writePackageJson({
        name: 'my-lib',
        exports: { '.': './src/index.js' },
        dependencies: { '@opentelemetry/api': '^1.0.0' },
      });

      const results = checkOtelApiDependencyPlacement(filePath, projectRoot);
      const failures = results.filter(r => !r.passed);

      expect(failures).toHaveLength(1);
      expect(failures[0].ruleId).toBe('API-002');
      expect(failures[0].message).toContain('peerDependencies');
      expect(failures[0].message).toContain('library');
    });

    it('fails when @opentelemetry/api is missing entirely from a library', () => {
      writePackageJson({
        name: 'my-lib',
        main: 'dist/index.js',
        dependencies: { express: '^4.0.0' },
      });

      const results = checkOtelApiDependencyPlacement(filePath, projectRoot);
      const failures = results.filter(r => !r.passed);

      expect(failures).toHaveLength(1);
      expect(failures[0].ruleId).toBe('API-002');
      expect(failures[0].message).toContain('not found');
    });

    it('treats a package with "module" field as a library', () => {
      writePackageJson({
        name: 'my-esm-lib',
        module: 'dist/index.mjs',
        peerDependencies: { '@opentelemetry/api': '^1.0.0' },
      });

      const results = checkOtelApiDependencyPlacement(filePath, projectRoot);

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('treats a package with "types" field as a library', () => {
      writePackageJson({
        name: 'my-typed-lib',
        types: 'dist/index.d.ts',
        peerDependencies: { '@opentelemetry/api': '^1.0.0' },
      });

      const results = checkOtelApiDependencyPlacement(filePath, projectRoot);

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });
  });

  describe('app projects (dependency accepted)', () => {
    it('passes when @opentelemetry/api is in dependencies for a private app', () => {
      writePackageJson({
        name: 'my-app',
        private: true,
        dependencies: { '@opentelemetry/api': '^1.0.0' },
      });

      const results = checkOtelApiDependencyPlacement(filePath, projectRoot);

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('fails when @opentelemetry/api is only in peerDependencies for an app', () => {
      writePackageJson({
        name: 'my-app',
        private: true,
        peerDependencies: { '@opentelemetry/api': '^1.0.0' },
      });

      const results = checkOtelApiDependencyPlacement(filePath, projectRoot);
      const failures = results.filter(r => !r.passed);

      expect(failures).toHaveLength(1);
      expect(failures[0].ruleId).toBe('API-002');
      expect(failures[0].message).toContain('peerDependencies');
      expect(failures[0].message).toContain('must list it in dependencies');
    });

    it('fails when @opentelemetry/api is missing entirely from an app', () => {
      writePackageJson({
        name: 'my-app',
        private: true,
        dependencies: { express: '^4.0.0' },
      });

      const results = checkOtelApiDependencyPlacement(filePath, projectRoot);
      const failures = results.filter(r => !r.passed);

      expect(failures).toHaveLength(1);
      expect(failures[0].ruleId).toBe('API-002');
      expect(failures[0].message).toContain('not found');
    });

    it('treats a package without main/exports/module/types and private:true as an app', () => {
      writePackageJson({
        name: 'my-service',
        private: true,
        scripts: { start: 'node server.js' },
        dependencies: { '@opentelemetry/api': '^1.0.0' },
      });

      const results = checkOtelApiDependencyPlacement(filePath, projectRoot);

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });
  });

  describe('project type detection edge cases', () => {
    it('treats private:true with main field as an app (private overrides library signals)', () => {
      writePackageJson({
        name: 'my-internal-pkg',
        private: true,
        main: 'dist/index.js',
        dependencies: { '@opentelemetry/api': '^1.0.0' },
      });

      const results = checkOtelApiDependencyPlacement(filePath, projectRoot);

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('treats a package without main/exports/module/types and without private as an app', () => {
      // No library signals and no private flag — defaults to app
      writePackageJson({
        name: 'my-script',
        dependencies: { '@opentelemetry/api': '^1.0.0' },
      });

      const results = checkOtelApiDependencyPlacement(filePath, projectRoot);

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });
  });

  describe('error handling', () => {
    it('passes with advisory message when package.json is missing', () => {
      // Don't create package.json — projectRoot exists but is empty
      const results = checkOtelApiDependencyPlacement(filePath, projectRoot);

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
      expect(results[0].message).toContain('package.json');
    });

    it('passes with advisory message when package.json is invalid JSON', () => {
      writeFileSync(join(projectRoot, 'package.json'), 'not json');

      const results = checkOtelApiDependencyPlacement(filePath, projectRoot);

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
      expect(results[0].message).toContain('package.json');
    });
  });

  describe('CheckResult structure', () => {
    it('returns correct structure for passing result', () => {
      writePackageJson({
        name: 'my-app',
        private: true,
        dependencies: { '@opentelemetry/api': '^1.0.0' },
      });

      const results = checkOtelApiDependencyPlacement(filePath, projectRoot);

      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({
        ruleId: 'API-002',
        passed: true,
        filePath,
        lineNumber: null,
        message: expect.any(String),
        tier: 2,
        blocking: false,
      });
    });

    it('returns correct structure for failing result', () => {
      writePackageJson({
        name: 'my-lib',
        main: 'dist/index.js',
        dependencies: { '@opentelemetry/api': '^1.0.0' },
      });

      const results = checkOtelApiDependencyPlacement(filePath, projectRoot);
      const failure = results.find(r => !r.passed);

      expect(failure).toBeDefined();
      expect(failure!.ruleId).toBe('API-002');
      expect(failure!.tier).toBe(2);
      expect(failure!.blocking).toBe(false);
      expect(failure!.lineNumber).toBeNull();
    });
  });
});

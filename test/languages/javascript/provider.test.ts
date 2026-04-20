// ABOUTME: Unit tests for JavaScriptProvider — the LanguageProvider implementation for JavaScript.
// ABOUTME: Verifies identity fields, delegation to JS modules, and language-agnostic type mapping.

import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JavaScriptProvider } from '../../../src/languages/javascript/index.ts';
import type { FunctionInfo } from '../../../src/languages/types.ts';

describe('JavaScriptProvider', () => {
  const provider = new JavaScriptProvider();

  // ─── Identity ─────────────────────────────────────────────────────────────

  describe('identity fields', () => {
    it('has correct id', () => {
      expect(provider.id).toBe('javascript');
    });

    it('has correct displayName', () => {
      expect(provider.displayName).toBe('JavaScript');
    });

    it('handles .js and .jsx extensions', () => {
      expect(provider.fileExtensions).toContain('.js');
      expect(provider.fileExtensions).toContain('.jsx');
    });

    it('has glob pattern for js and jsx files', () => {
      expect(provider.globPattern).toBe('**/*.{js,jsx}');
    });

    it('excludes node_modules and dist from discovery', () => {
      expect(provider.defaultExclude).toContain('**/node_modules/**');
      expect(provider.defaultExclude).toContain('**/dist/**');
    });

    it('has correct OTel API package', () => {
      expect(provider.otelApiPackage).toBe('@opentelemetry/api');
    });

    it('has correct OTel semconv package', () => {
      expect(provider.otelSemconvPackage).toBe('@opentelemetry/semantic-conventions');
    });

    it('has npm as package manager', () => {
      expect(provider.packageManager).toBe('npm');
    });

    it('has package.json as dependency file', () => {
      expect(provider.dependencyFile).toBe('package.json');
    });
  });

  // ─── OTel pattern detection ─────────────────────────────────────────────

  describe('otelImportPattern', () => {
    it('matches OTel API import with single quotes', () => {
      expect(provider.otelImportPattern.test("import { trace } from '@opentelemetry/api'")).toBe(true);
    });

    it('matches OTel API import with double quotes', () => {
      expect(provider.otelImportPattern.test('import { trace } from "@opentelemetry/api"')).toBe(true);
    });

    it('does not match non-OTel imports', () => {
      expect(provider.otelImportPattern.test("import express from 'express'")).toBe(false);
    });

    it('does not match other OTel packages (only @opentelemetry/api)', () => {
      expect(provider.otelImportPattern.test("import { NodeSDK } from '@opentelemetry/sdk-node'")).toBe(false);
    });
  });

  describe('spanCreationPattern', () => {
    it('matches startActiveSpan', () => {
      expect(provider.spanCreationPattern.test('tracer.startActiveSpan(')).toBe(true);
    });

    it('matches startSpan', () => {
      expect(provider.spanCreationPattern.test('tracer.startSpan(')).toBe(true);
    });

    it('does not match unrelated calls', () => {
      expect(provider.spanCreationPattern.test('console.log(')).toBe(false);
    });
  });

  // ─── Package management ─────────────────────────────────────────────────

  describe('installCommand', () => {
    it('builds npm install command for one package', () => {
      expect(provider.installCommand(['@opentelemetry/api']))
        .toBe('npm install @opentelemetry/api');
    });

    it('builds npm install command for multiple packages', () => {
      expect(provider.installCommand(['@opentelemetry/api', '@opentelemetry/sdk-node']))
        .toBe('npm install @opentelemetry/api @opentelemetry/sdk-node');
    });
  });

  // ─── Feature parity ─────────────────────────────────────────────────────

  describe('hasImplementation', () => {
    // B3: hasImplementation() checks the registered ValidationRule list.
    // NDS-001 (syntax) and LINT are Tier 1 provider methods, not ValidationRules.
    const RULE_IDS = [
      'COV-001', 'COV-002', 'COV-003', 'COV-004', 'COV-005', 'COV-006',
      'RST-001', 'RST-002', 'RST-003', 'RST-004', 'RST-005',
      'NDS-003', 'NDS-004', 'NDS-005', 'NDS-006',
      'CDQ-001', 'CDQ-006', 'CDQ-008',
      'API-001', 'API-002', 'API-004',
      'SCH-001', 'SCH-002', 'SCH-003', 'SCH-004',
    ];

    it('returns true for all ValidationRule IDs registered by this provider', () => {
      for (const ruleId of RULE_IDS) {
        expect(provider.hasImplementation(ruleId), `Expected hasImplementation('${ruleId}') to be true`).toBe(true);
      }
    });

    it('returns false for Tier 1 checks that are provider methods, not ValidationRules', () => {
      // NDS-001 (syntax) and LINT are dispatched via provider.checkSyntax()/lintCheck()
      expect(provider.hasImplementation('NDS-001')).toBe(false);
      expect(provider.hasImplementation('LINT')).toBe(false);
    });

    it('returns false for unknown rule IDs', () => {
      expect(provider.hasImplementation('UNKNOWN-001')).toBe(false);
      expect(provider.hasImplementation('')).toBe(false);
    });
  });

  // ─── AST analysis ──────────────────────────────────────────────────────

  describe('findFunctions', () => {
    it('returns language-agnostic FunctionInfo with endLine', () => {
      const source = `export async function greet(name) {
  return \`Hello, \${name}\`;
}`;
      const fns = provider.findFunctions(source);
      expect(fns).toHaveLength(1);
      expect(fns[0].name).toBe('greet');
      expect(fns[0].isAsync).toBe(true);
      expect(fns[0].isExported).toBe(true);
      expect(typeof fns[0].endLine).toBe('number');
      expect(fns[0].endLine).toBeGreaterThanOrEqual(fns[0].startLine);
    });

    it('finds both function declarations and arrow functions', () => {
      const source = `export function foo() { return 1; }
export const bar = () => 2;`;
      const fns = provider.findFunctions(source);
      const names = fns.map(f => f.name);
      expect(names).toContain('foo');
      expect(names).toContain('bar');
    });

    it('returns empty array for source with no functions', () => {
      const source = `const x = 42;`;
      expect(provider.findFunctions(source)).toHaveLength(0);
    });
  });

  describe('findImports', () => {
    it('returns language-agnostic ImportInfo for named imports', () => {
      const source = `import { trace, SpanStatusCode } from '@opentelemetry/api';`;
      const imports = provider.findImports(source);
      const otelImport = imports.find(i => i.moduleSpecifier === '@opentelemetry/api');
      expect(otelImport).toBeDefined();
      expect(otelImport!.importedNames).toContain('trace');
      expect(otelImport!.importedNames).toContain('SpanStatusCode');
      expect(otelImport!.lineNumber).toBe(1);
    });

    it('includes default imports in importedNames', () => {
      const source = `import express from 'express';`;
      const imports = provider.findImports(source);
      const expressImport = imports.find(i => i.moduleSpecifier === 'express');
      expect(expressImport).toBeDefined();
      expect(expressImport!.importedNames).toContain('express');
    });

    it('maps namespace imports to alias field', () => {
      const source = `import * as fs from 'node:fs';`;
      const imports = provider.findImports(source);
      const fsImport = imports.find(i => i.moduleSpecifier === 'node:fs');
      expect(fsImport).toBeDefined();
      expect(fsImport!.alias).toBe('fs');
    });

    it('returns empty array for source with no imports', () => {
      const source = `export function greet() { return 'hello'; }`;
      expect(provider.findImports(source)).toHaveLength(0);
    });
  });

  describe('findExports', () => {
    it('finds named function exports', () => {
      const source = `export function foo() {}`;
      const exports = provider.findExports(source);
      expect(exports.some(e => e.name === 'foo' && !e.isDefault)).toBe(true);
    });

    it('finds named variable exports', () => {
      const source = `export const bar = 42;`;
      const exports = provider.findExports(source);
      expect(exports.some(e => e.name === 'bar' && !e.isDefault)).toBe(true);
    });

    it('identifies anonymous default export as single entry', () => {
      const source = `export default function() {}`;
      const exports = provider.findExports(source);
      expect(exports).toHaveLength(1);
      expect(exports[0]).toMatchObject({ isDefault: true });
    });

    it('finds re-exported names', () => {
      const source = `function foo() {}
function bar() {}
export { foo, bar };`;
      const exports = provider.findExports(source);
      const names = exports.map(e => e.name);
      expect(names).toContain('foo');
      expect(names).toContain('bar');
    });

    it('returns empty array for no exports', () => {
      const source = `function internal() {}`;
      expect(provider.findExports(source)).toHaveLength(0);
    });

    it('does not produce duplicate entries for export default function foo() {}', () => {
      const source = `export default function foo() {}`;
      const exports = provider.findExports(source);
      expect(exports).toHaveLength(1);
      expect(exports[0]).toMatchObject({ name: 'foo', isDefault: true });
    });
  });

  describe('classifyFunction', () => {
    it('returns unknown for all functions (requires source context)', () => {
      const fn: FunctionInfo = {
        name: 'greet',
        startLine: 1,
        endLine: 3,
        isExported: true,
        isAsync: false,
        lineCount: 3,
      };
      expect(provider.classifyFunction(fn)).toBe('unknown');
    });
  });

  describe('detectExistingInstrumentation', () => {
    it('returns true for files with OTel imports', () => {
      const source = `import { trace } from '@opentelemetry/api';
export function greet() {}`;
      expect(provider.detectExistingInstrumentation(source)).toBe(true);
    });

    it('returns true for files with span creation patterns', () => {
      const source = `export async function greet() {
  return tracer.startActiveSpan('greet', async (span) => {
    span.end();
  });
}`;
      expect(provider.detectExistingInstrumentation(source)).toBe(true);
    });

    it('returns false for plain uninstrumented files', () => {
      const source = `export function greet(name) { return name; }`;
      expect(provider.detectExistingInstrumentation(source)).toBe(false);
    });
  });

  // ─── Function extraction / reassembly ──────────────────────────────────

  describe('extractFunctions', () => {
    it('returns language-agnostic ExtractedFunction with contextHeader (pre-built string)', () => {
      const source = `import { Pool } from 'pg';
const pool = new Pool();
export async function getUsers(req, res) {
  const result = await pool.query('SELECT * FROM users');
  res.json(result.rows);
  return result;
}`;
      const extracted = provider.extractFunctions(source);
      expect(extracted).toHaveLength(1);
      expect(extracted[0].name).toBe('getUsers');
      expect(typeof extracted[0].contextHeader).toBe('string');
      // Language-agnostic type uses docComment, not jsDoc
      expect('jsDoc' in extracted[0]).toBe(false);
      // Language-agnostic type drops referencedConstants
      expect('referencedConstants' in extracted[0]).toBe(false);
    });

    it('returns empty array when no functions qualify', () => {
      const source = `const x = 42;`;
      expect(provider.extractFunctions(source)).toHaveLength(0);
    });
  });

  describe('reassembleFunctions', () => {
    it('returns original source unchanged when no successful results', () => {
      const source = `export async function getUsers(req, res) {
  const result = await pool.query('SELECT * FROM users');
  res.json(result.rows);
  return result;
}`;
      const extracted = provider.extractFunctions(source);
      const result = provider.reassembleFunctions(source, extracted, []);
      expect(result).toBe(source);
    });
  });

  // ─── Prompt sections ────────────────────────────────────────────────────

  describe('getSystemPromptSections', () => {
    it('returns LanguagePromptSections with all required fields', () => {
      const sections = provider.getSystemPromptSections();
      expect(typeof sections.constraints).toBe('string');
      expect(typeof sections.otelPatterns).toBe('string');
      expect(typeof sections.tracerAcquisition).toBe('string');
      expect(typeof sections.spanCreation).toBe('string');
      expect(typeof sections.errorHandling).toBe('string');
      expect(typeof sections.libraryInstallation).toBe('string');
      // All sections should be non-empty
      expect(sections.constraints.length).toBeGreaterThan(0);
      expect(sections.otelPatterns.length).toBeGreaterThan(0);
    });
  });

  describe('getInstrumentationExamples', () => {
    it('returns at least one example with before/after/description', () => {
      const examples = provider.getInstrumentationExamples();
      expect(examples.length).toBeGreaterThan(0);
      expect(typeof examples[0].description).toBe('string');
      expect(typeof examples[0].before).toBe('string');
      expect(typeof examples[0].after).toBe('string');
      expect(examples[0].description.length).toBeGreaterThan(0);
    });
  });

  // ─── Project metadata ──────────────────────────────────────────────────

  describe('readProjectName', () => {
    it('reads the name field from package.json', async () => {
      const tmpDir = await mkdtemp(join(tmpdir(), 'js-provider-test-'));
      try {
        await writeFile(join(tmpDir, 'package.json'), JSON.stringify({ name: 'my-project', version: '1.0.0' }));
        const name = await provider.readProjectName(tmpDir);
        expect(name).toBe('my-project');
      } finally {
        await rm(tmpDir, { recursive: true });
      }
    });

    it('returns undefined when package.json does not exist', async () => {
      const tmpDir = await mkdtemp(join(tmpdir(), 'js-provider-test-'));
      try {
        const name = await provider.readProjectName(tmpDir);
        expect(name).toBeUndefined();
      } finally {
        await rm(tmpDir, { recursive: true });
      }
    });

    it('returns undefined when package.json exists but has no name field', async () => {
      const tmpDir = await mkdtemp(join(tmpdir(), 'js-provider-test-'));
      try {
        await writeFile(join(tmpDir, 'package.json'), JSON.stringify({ version: '1.0.0' }));
        const name = await provider.readProjectName(tmpDir);
        expect(name).toBeUndefined();
      } finally {
        await rm(tmpDir, { recursive: true });
      }
    });

    it('throws when package.json exists but contains invalid JSON', async () => {
      const tmpDir = await mkdtemp(join(tmpdir(), 'js-provider-test-'));
      try {
        await writeFile(join(tmpDir, 'package.json'), 'not valid json {{ broken');
        await expect(provider.readProjectName(tmpDir)).rejects.toThrow();
      } finally {
        await rm(tmpDir, { recursive: true });
      }
    });
  });
});

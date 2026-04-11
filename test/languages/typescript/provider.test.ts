// ABOUTME: Unit tests for TypeScriptProvider — the LanguageProvider implementation for TypeScript.
// ABOUTME: Verifies identity fields, delegation to TS modules, and language-agnostic type mapping.

import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TypeScriptProvider } from '../../../src/languages/typescript/index.ts';
import type { FunctionInfo } from '../../../src/languages/types.ts';

describe('TypeScriptProvider', () => {
  const provider = new TypeScriptProvider();

  // ─── Identity ─────────────────────────────────────────────────────────────

  describe('identity fields', () => {
    it('has correct id', () => {
      expect(provider.id).toBe('typescript');
    });

    it('has correct displayName', () => {
      expect(provider.displayName).toBe('TypeScript');
    });

    it('handles .ts and .tsx extensions', () => {
      expect(provider.fileExtensions).toContain('.ts');
      expect(provider.fileExtensions).toContain('.tsx');
    });

    it('has glob pattern for ts and tsx files', () => {
      expect(provider.globPattern).toBe('**/*.{ts,tsx}');
    });

    it('excludes node_modules, dist, and .d.ts files from discovery', () => {
      expect(provider.defaultExclude).toContain('**/node_modules/**');
      expect(provider.defaultExclude).toContain('**/dist/**');
      expect(provider.defaultExclude).toContain('**/*.d.ts');
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
    it('returns false for all rule IDs in C1 (no TS rules registered yet)', () => {
      // TypeScript Tier 2 rules are added in Milestone C3.
      // In C1 the provider implements all interface methods but registers no rules.
      expect(provider.hasImplementation('COV-001')).toBe(false);
      expect(provider.hasImplementation('NDS-001')).toBe(false);
      expect(provider.hasImplementation('SCH-002')).toBe(false);
    });

    it('returns false for unknown rule IDs', () => {
      expect(provider.hasImplementation('UNKNOWN-001')).toBe(false);
      expect(provider.hasImplementation('')).toBe(false);
    });
  });

  // ─── AST analysis ──────────────────────────────────────────────────────

  describe('findFunctions', () => {
    it('finds TypeScript function declarations with type annotations', () => {
      const source = `export async function greet(name: string): Promise<string> {
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

    it('finds TypeScript arrow functions with type annotations', () => {
      const source = `export const handler = async (req: Request): Promise<void> => {
  return;
};`;
      const fns = provider.findFunctions(source);
      expect(fns.some(f => f.name === 'handler')).toBe(true);
    });

    it('finds generic functions (preserves type parameters)', () => {
      const source = `export function identity<T>(value: T): T {
  return value;
}`;
      const fns = provider.findFunctions(source);
      expect(fns).toHaveLength(1);
      expect(fns[0].name).toBe('identity');
    });

    it('returns empty array for source with no functions', () => {
      const source = `const x: number = 42;`;
      expect(provider.findFunctions(source)).toHaveLength(0);
    });

    it('finds both function declarations and arrow functions', () => {
      const source = `export function foo(): number { return 1; }
export const bar = (): number => 2;`;
      const fns = provider.findFunctions(source);
      const names = fns.map(f => f.name);
      expect(names).toContain('foo');
      expect(names).toContain('bar');
    });

    it('returns language-agnostic FunctionInfo (has endLine field)', () => {
      const source = `export function greet(name: string): string {
  return name;
}`;
      const fns = provider.findFunctions(source);
      expect(fns.length).toBeGreaterThan(0);
      expect(typeof fns[0].endLine).toBe('number');
    });
  });

  describe('findImports', () => {
    it('returns ImportInfo for named imports', () => {
      const source = `import { trace, SpanStatusCode } from '@opentelemetry/api';`;
      const imports = provider.findImports(source);
      const otelImport = imports.find(i => i.moduleSpecifier === '@opentelemetry/api');
      expect(otelImport).toBeDefined();
      expect(otelImport!.importedNames).toContain('trace');
      expect(otelImport!.importedNames).toContain('SpanStatusCode');
    });

    it('handles import type declarations', () => {
      const source = `import type { Request, Response } from 'express';`;
      const imports = provider.findImports(source);
      const expressImport = imports.find(i => i.moduleSpecifier === 'express');
      expect(expressImport).toBeDefined();
      // import type names are included in importedNames
      expect(expressImport!.importedNames).toContain('Request');
    });

    it('handles default imports', () => {
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
      const source = `export function greet(): string { return 'hello'; }`;
      expect(provider.findImports(source)).toHaveLength(0);
    });

    it('returns raw specifiers — no tsconfig.json path alias resolution', () => {
      // OD-3: return raw specifier as-is, not a resolved filesystem path
      const source = `import { UserService } from '@app/services/user';`;
      const imports = provider.findImports(source);
      expect(imports[0].moduleSpecifier).toBe('@app/services/user');
    });
  });

  describe('findExports', () => {
    it('finds named function exports', () => {
      const source = `export function foo(): void {}`;
      const exports = provider.findExports(source);
      expect(exports.some(e => e.name === 'foo' && !e.isDefault)).toBe(true);
    });

    it('finds named variable exports', () => {
      const source = `export const bar: number = 42;`;
      const exports = provider.findExports(source);
      expect(exports.some(e => e.name === 'bar' && !e.isDefault)).toBe(true);
    });

    it('identifies default exports', () => {
      const source = `export default function(): void {}`;
      const exports = provider.findExports(source);
      expect(exports.some(e => e.isDefault)).toBe(true);
    });

    it('finds re-exported names', () => {
      const source = `function foo(): void {}
function bar(): void {}
export { foo, bar };`;
      const exports = provider.findExports(source);
      const names = exports.map(e => e.name);
      expect(names).toContain('foo');
      expect(names).toContain('bar');
    });

    it('returns empty array for no exports', () => {
      const source = `function internal(): void {}`;
      expect(provider.findExports(source)).toHaveLength(0);
    });

    it('excludes type-only re-exports (export type { Foo })', () => {
      const source = `type Foo = string;
export type { Foo };`;
      // type-only re-exports are not runtime values — should not appear in ExportInfo
      expect(provider.findExports(source)).toHaveLength(0);
    });

    it('excludes type-only specifiers in mixed exports (export { type Foo, Bar })', () => {
      const source = `type Foo = string;
function bar(): void {}
export { type Foo, bar };`;
      const exports = provider.findExports(source);
      const names = exports.map(e => e.name);
      expect(names).toContain('bar');
      expect(names).not.toContain('Foo');
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
    it('returns true for TypeScript files with OTel imports', () => {
      const source = `import { trace } from '@opentelemetry/api';
export function greet(): string { return 'hi'; }`;
      expect(provider.detectExistingInstrumentation(source)).toBe(true);
    });

    it('returns true for TypeScript files with span creation patterns', () => {
      const source = `export async function greet(): Promise<string> {
  return tracer.startActiveSpan('greet', async (span) => {
    span.end();
    return 'hi';
  });
}`;
      expect(provider.detectExistingInstrumentation(source)).toBe(true);
    });

    it('returns false for plain TypeScript files without instrumentation', () => {
      const source = `export function greet(name: string): string { return name; }`;
      expect(provider.detectExistingInstrumentation(source)).toBe(false);
    });
  });

  // ─── Function extraction / reassembly ──────────────────────────────────

  describe('extractFunctions', () => {
    it('returns language-agnostic ExtractedFunction with contextHeader (pre-built string)', () => {
      const source = `import { Pool } from 'pg';
const pool: Pool = new Pool();
export async function getUsers(req: Request, res: Response): Promise<void> {
  const result = await pool.query('SELECT * FROM users');
  res.json(result.rows);
  return;
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
      const source = `const x: number = 42;`;
      expect(provider.extractFunctions(source)).toHaveLength(0);
    });
  });

  describe('reassembleFunctions', () => {
    it('returns original source unchanged when no successful results', () => {
      const source = `export async function getUsers(req: Request, res: Response): Promise<void> {
  const result = await pool.query('SELECT * FROM users');
  res.json(result.rows);
  return;
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
      expect(sections.constraints.length).toBeGreaterThan(0);
      expect(sections.otelPatterns.length).toBeGreaterThan(0);
    });

    it('constraints mention TypeScript-specific concerns (type annotations, import type)', () => {
      const sections = provider.getSystemPromptSections();
      // TypeScript provider must warn against stripping type annotations
      expect(sections.constraints.toLowerCase()).toMatch(/type annotation|import type/);
    });
  });

  describe('getInstrumentationExamples', () => {
    it('returns at least 5 examples with before/after/description', () => {
      const examples = provider.getInstrumentationExamples();
      expect(examples.length).toBeGreaterThanOrEqual(5);
      for (const ex of examples) {
        expect(typeof ex.description).toBe('string');
        expect(typeof ex.before).toBe('string');
        expect(typeof ex.after).toBe('string');
        expect(ex.description.length).toBeGreaterThan(0);
      }
    });

    it('examples include TypeScript syntax (type annotations)', () => {
      const examples = provider.getInstrumentationExamples();
      // At least one example should have TypeScript type annotations
      const hasTypeAnnotations = examples.some(ex =>
        ex.before.includes(': string') ||
        ex.before.includes(': number') ||
        ex.before.includes(': Promise') ||
        ex.before.includes(': void') ||
        ex.before.includes('<T>') ||
        ex.before.includes(': Request'),
      );
      expect(hasTypeAnnotations).toBe(true);
    });
  });

  // ─── Project metadata ──────────────────────────────────────────────────

  describe('readProjectName', () => {
    it('reads the name field from package.json', async () => {
      const tmpDir = await mkdtemp(join(tmpdir(), 'ts-provider-test-'));
      try {
        await writeFile(join(tmpDir, 'package.json'), JSON.stringify({ name: 'my-ts-project', version: '1.0.0' }));
        const name = await provider.readProjectName(tmpDir);
        expect(name).toBe('my-ts-project');
      } finally {
        await rm(tmpDir, { recursive: true });
      }
    });

    it('returns undefined when package.json does not exist', async () => {
      const tmpDir = await mkdtemp(join(tmpdir(), 'ts-provider-test-'));
      try {
        const name = await provider.readProjectName(tmpDir);
        expect(name).toBeUndefined();
      } finally {
        await rm(tmpDir, { recursive: true });
      }
    });

    it('returns undefined when package.json has no name field', async () => {
      const tmpDir = await mkdtemp(join(tmpdir(), 'ts-provider-test-'));
      try {
        await writeFile(join(tmpDir, 'package.json'), JSON.stringify({ version: '1.0.0' }));
        const name = await provider.readProjectName(tmpDir);
        expect(name).toBeUndefined();
      } finally {
        await rm(tmpDir, { recursive: true });
      }
    });
  });
});

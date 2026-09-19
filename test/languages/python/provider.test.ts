// ABOUTME: Unit tests for PythonProvider — the LanguageProvider implementation for Python.
// ABOUTME: Verifies identity fields, delegation to Python-specific modules, and interface compliance.

import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PythonProvider } from '../../../src/languages/python/index.ts';
import type { FunctionInfo } from '../../../src/languages/types.ts';

describe('PythonProvider', () => {
  const provider = new PythonProvider();

  // ─── Identity ─────────────────────────────────────────────────────────────

  describe('identity fields', () => {
    it('has correct id', () => {
      expect(provider.id).toBe('python');
    });

    it('has correct displayName', () => {
      expect(provider.displayName).toBe('Python');
    });

    it('handles .py extension', () => {
      expect(provider.fileExtensions).toEqual(['.py']);
    });

    it('has glob pattern for py files', () => {
      expect(provider.globPattern).toBe('**/*.py');
    });

    it('excludes __pycache__, venv, and test files from discovery', () => {
      expect(provider.defaultExclude).toContain('**/__pycache__/**');
      expect(provider.defaultExclude).toContain('**/.venv/**');
      expect(provider.defaultExclude).toContain('**/venv/**');
      expect(provider.defaultExclude).toContain('**/*.pyc');
      expect(provider.defaultExclude).toContain('**/migrations/**');
      expect(provider.defaultExclude).toContain('**/test_*.py');
      expect(provider.defaultExclude).toContain('**/*_test.py');
    });

    it('has correct OTel API package', () => {
      expect(provider.otelApiPackage).toBe('opentelemetry-api');
    });

    it('has null OTel semconv package (OD-8b: raw attribute strings, not typed constants)', () => {
      expect(provider.otelSemconvPackage).toBeNull();
    });

    it('has pip as package manager', () => {
      expect(provider.packageManager).toBe('pip');
    });

    it('has pyproject.toml as dependency file', () => {
      expect(provider.dependencyFile).toBe('pyproject.toml');
    });
  });

  // ─── OTel pattern detection ─────────────────────────────────────────────

  describe('otelImportPattern', () => {
    it('matches OTel import', () => {
      expect(provider.otelImportPattern.test('from opentelemetry import trace')).toBe(true);
    });

    it('does not match non-OTel imports', () => {
      expect(provider.otelImportPattern.test('from flask import Flask')).toBe(false);
    });
  });

  describe('spanCreationPattern', () => {
    it('matches start_as_current_span', () => {
      expect(provider.spanCreationPattern.test('with tracer.start_as_current_span(')).toBe(true);
    });

    it('matches start_span', () => {
      expect(provider.spanCreationPattern.test('span = tracer.start_span(')).toBe(true);
    });

    it('does not match unrelated calls', () => {
      expect(provider.spanCreationPattern.test('print(')).toBe(false);
    });
  });

  // ─── Package management ─────────────────────────────────────────────────

  describe('installCommand', () => {
    it('builds pip install command for one package', () => {
      expect(provider.installCommand(['opentelemetry-api'])).toBe('pip install opentelemetry-api');
    });

    it('builds pip install command for multiple packages', () => {
      expect(provider.installCommand(['opentelemetry-api', 'opentelemetry-sdk']))
        .toBe('pip install opentelemetry-api opentelemetry-sdk');
    });
  });

  // ─── Feature parity ─────────────────────────────────────────────────────

  describe('hasImplementation', () => {
    it('returns false for all rule IDs (no Python rules until Milestone D3)', () => {
      expect(provider.hasImplementation('COV-001')).toBe(false);
      expect(provider.hasImplementation('NDS-001')).toBe(false);
      expect(provider.hasImplementation('UNKNOWN-001')).toBe(false);
      expect(provider.hasImplementation('')).toBe(false);
    });
  });

  // ─── AST analysis ──────────────────────────────────────────────────────

  describe('findFunctions', () => {
    it('finds Python function definitions', () => {
      const source = `async def greet(name):\n    return f"Hello, {name}"\n`;
      const fns = provider.findFunctions(source);
      expect(fns).toHaveLength(1);
      expect(fns[0].name).toBe('greet');
      expect(fns[0].isAsync).toBe(true);
      expect(fns[0].isExported).toBe(true);
      expect(typeof fns[0].endLine).toBe('number');
      expect(fns[0].endLine).toBeGreaterThanOrEqual(fns[0].startLine);
    });

    it('marks underscore-prefixed functions as not exported', () => {
      const source = `def _helper():\n    return 1\n`;
      const fns = provider.findFunctions(source);
      expect(fns[0].isExported).toBe(false);
    });

    it('returns empty array for source with no functions', () => {
      const source = `x = 42\n`;
      expect(provider.findFunctions(source)).toHaveLength(0);
    });
  });

  describe('findImports', () => {
    it('returns ImportInfo for from-imports', () => {
      const source = `from opentelemetry import trace\n`;
      const imports = provider.findImports(source);
      const otelImport = imports.find(i => i.moduleSpecifier === 'opentelemetry');
      expect(otelImport).toBeDefined();
      expect(otelImport!.importedNames).toContain('trace');
    });

    it('returns empty array for source with no imports', () => {
      const source = `def greet():\n    return "hello"\n`;
      expect(provider.findImports(source)).toHaveLength(0);
    });
  });

  describe('findExports', () => {
    it('finds public (non-underscore) module-level functions', () => {
      const source = `def foo():\n    pass\n`;
      const exports = provider.findExports(source);
      expect(exports.some(e => e.name === 'foo')).toBe(true);
    });

    it('returns empty array when no public symbols exist', () => {
      const source = `def _internal():\n    pass\n`;
      expect(provider.findExports(source)).toHaveLength(0);
    });
  });

  describe('classifyFunction', () => {
    it('returns unknown (Flask/FastAPI classification is Milestone D3 work)', () => {
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
    it('returns true for Python files with OTel imports', () => {
      const source = `from opentelemetry import trace\n\ndef greet():\n    return "hi"\n`;
      expect(provider.detectExistingInstrumentation(source)).toBe(true);
    });

    it('returns true for Python files with span creation patterns', () => {
      const source = `def greet():\n    with tracer.start_as_current_span("greet") as span:\n        return "hi"\n`;
      expect(provider.detectExistingInstrumentation(source)).toBe(true);
    });

    it('returns false for plain Python files without instrumentation', () => {
      const source = `def greet(name):\n    return name\n`;
      expect(provider.detectExistingInstrumentation(source)).toBe(false);
    });
  });

  describe('detectOTelInstrumentation', () => {
    it('returns no patterns for uninstrumented Python files', () => {
      const source = `def greet(name):\n    return name\n`;
      const result = provider.detectOTelInstrumentation(source);
      expect(result.hasExistingInstrumentation).toBe(false);
      expect(result.spanPatterns).toEqual([]);
    });

    it('detects start_as_current_span with enclosing function name', () => {
      const source = `from opentelemetry import trace\ntracer = trace.get_tracer("my-service")\n\ndef fetch_user(user_id):\n    with tracer.start_as_current_span("fetch_user") as span:\n        return {"id": user_id}\n`;
      const result = provider.detectOTelInstrumentation(source);
      expect(result.hasExistingInstrumentation).toBe(true);
      expect(result.spanPatterns[0]?.enclosingFunction).toBe('fetch_user');
    });
  });

  // ─── Function extraction / reassembly ──────────────────────────────────

  describe('extractFunctions', () => {
    it('returns language-agnostic ExtractedFunction for a qualifying function', () => {
      const source = `def get_users(request):\n    result = db.query("SELECT * FROM users")\n    users = [row.to_dict() for row in result]\n    return users\n`;
      const extracted = provider.extractFunctions(source);
      expect(extracted).toHaveLength(1);
      expect(extracted[0].name).toBe('get_users');
      expect(typeof extracted[0].contextHeader).toBe('string');
    });

    it('returns empty array when no functions qualify', () => {
      const source = `x = 42\n`;
      expect(provider.extractFunctions(source)).toHaveLength(0);
    });
  });

  describe('reassembleFunctions', () => {
    it('returns original source unchanged when no successful results', () => {
      const source = `def get_users(request):\n    result = db.query("SELECT * FROM users")\n    users = [row.to_dict() for row in result]\n    return users\n`;
      const extracted = provider.extractFunctions(source);
      const result = provider.reassembleFunctions(source, extracted, []);
      expect(result).toBe(source);
    });
  });

  // ─── Auto-fixes (no-ops — no Python equivalent yet) ────────────────────

  describe('JS-specific auto-fix pass-throughs', () => {
    const code = 'def foo():\n    pass\n';

    it('ensureTracerAfterImports returns code unchanged', () => {
      expect(provider.ensureTracerAfterImports(code)).toBe(code);
    });

    it('fixProcessExitSpanEnd returns code unchanged', () => {
      expect(provider.fixProcessExitSpanEnd(code)).toBe(code);
    });

    it('fixAttributeTypeCoercions returns code unchanged', () => {
      expect(provider.fixAttributeTypeCoercions(code, {})).toBe(code);
    });

    it('fixIsRecordingGuards returns code unchanged', () => {
      expect(provider.fixIsRecordingGuards(code)).toBe(code);
    });

    it('fixUntypedStringMethods returns code unchanged', () => {
      expect(provider.fixUntypedStringMethods(code)).toBe(code);
    });

    it('fixNotNullSafeGuards returns code unchanged', () => {
      expect(provider.fixNotNullSafeGuards(code)).toBe(code);
    });

    it('fixDelimiterVariants returns code unchanged', () => {
      expect(provider.fixDelimiterVariants(code, [], [])).toBe(code);
    });

    it('fixCanonicalTracerName returns code unchanged', () => {
      expect(provider.fixCanonicalTracerName(code, 'my-service')).toBe(code);
    });
  });

  describe('getFormatterConstraint', () => {
    it('returns empty string', async () => {
      expect(await provider.getFormatterConstraint('/tmp/file.py')).toBe('');
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

    it('constraints include the hard span.end() prohibition', () => {
      const sections = provider.getSystemPromptSections();
      expect(sections.constraints).toMatch(/do not call.*span\.end\(\)/i);
    });

    it('otelPatterns include the PRD #581 registry-first attribute priority guidance', () => {
      const sections = provider.getSystemPromptSections();
      expect(sections.otelPatterns).toMatch(/registry/i);
      expect(sections.otelPatterns).toMatch(/training data/i);
    });

    it('libraryInstallation is pip install opentelemetry-api', () => {
      const sections = provider.getSystemPromptSections();
      expect(sections.libraryInstallation).toBe('pip install opentelemetry-api');
    });

    it('errorHandling and spanCreation warn against duplicate exception recording on re-raise', () => {
      const sections = provider.getSystemPromptSections();
      expect(sections.errorHandling).toMatch(/do not add manual.*re-raises/i);
      expect(sections.errorHandling).toMatch(/duplicate exception event/i);
      expect(sections.spanCreation).toMatch(/duplicate exception event/i);
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

    it('no example calls span.end() in its after code', () => {
      const examples = provider.getInstrumentationExamples();
      for (const ex of examples) {
        expect(ex.after).not.toMatch(/span\.end\(\)/);
      }
    });

    it('no example captures a high-cardinality user_id or order_id attribute', () => {
      const examples = provider.getInstrumentationExamples();
      for (const ex of examples) {
        expect(ex.after).not.toMatch(/set_attribute\("user\.id"/);
        expect(ex.after).not.toMatch(/set_attribute\("order\.id"/);
      }
    });

    it('only the swallowed-exception example manually calls record_exception', () => {
      const examples = provider.getInstrumentationExamples();
      const withManualRecording = examples.filter(ex => /record_exception/.test(ex.after));
      expect(withManualRecording).toHaveLength(1);
      expect(withManualRecording[0]?.description).toMatch(/swallows a real error/i);
    });

    it('includes a Flask example and a FastAPI example', () => {
      const examples = provider.getInstrumentationExamples();
      expect(examples.some(ex => ex.before.includes('Flask'))).toBe(true);
      expect(examples.some(ex => ex.before.includes('FastAPI'))).toBe(true);
    });
  });

  // ─── Project metadata ──────────────────────────────────────────────────

  describe('readProjectName', () => {
    it('reads the name field from pyproject.toml', async () => {
      const tmpDir = await mkdtemp(join(tmpdir(), 'py-provider-test-'));
      try {
        await writeFile(join(tmpDir, 'pyproject.toml'), '[project]\nname = "my-python-project"\nversion = "1.0.0"\n');
        const name = await provider.readProjectName(tmpDir);
        expect(name).toBe('my-python-project');
      } finally {
        await rm(tmpDir, { recursive: true });
      }
    });

    it('returns undefined when pyproject.toml does not exist', async () => {
      const tmpDir = await mkdtemp(join(tmpdir(), 'py-provider-test-'));
      try {
        const name = await provider.readProjectName(tmpDir);
        expect(name).toBeUndefined();
      } finally {
        await rm(tmpDir, { recursive: true });
      }
    });

    it('ignores a name field in an unrelated table and reads the [project] table instead', async () => {
      const tmpDir = await mkdtemp(join(tmpdir(), 'py-provider-test-'));
      try {
        await writeFile(
          join(tmpDir, 'pyproject.toml'),
          '[tool.some-plugin]\nname = "not-the-project-name"\n\n[project]\nname = "my-python-project"\n',
        );
        const name = await provider.readProjectName(tmpDir);
        expect(name).toBe('my-python-project');
      } finally {
        await rm(tmpDir, { recursive: true });
      }
    });

    it('recognizes a table header with a trailing inline comment', async () => {
      const tmpDir = await mkdtemp(join(tmpdir(), 'py-provider-test-'));
      try {
        await writeFile(join(tmpDir, 'pyproject.toml'), '[project]  # PEP 621 metadata\nname = "commented-header-project"\n');
        const name = await provider.readProjectName(tmpDir);
        expect(name).toBe('commented-header-project');
      } finally {
        await rm(tmpDir, { recursive: true });
      }
    });

    it('does not attribute a Poetry [[tool.poetry.source]] array-of-tables name to the project', async () => {
      const tmpDir = await mkdtemp(join(tmpdir(), 'py-provider-test-'));
      try {
        await writeFile(
          join(tmpDir, 'pyproject.toml'),
          '[project]\nversion = "1.0.0"\n\n[[tool.poetry.source]]\nname = "private-registry"\nurl = "https://example.com/simple"\n',
        );
        const name = await provider.readProjectName(tmpDir);
        expect(name).toBeUndefined();
      } finally {
        await rm(tmpDir, { recursive: true });
      }
    });

    it('reads the name field from [tool.poetry] when present instead of [project]', async () => {
      const tmpDir = await mkdtemp(join(tmpdir(), 'py-provider-test-'));
      try {
        await writeFile(join(tmpDir, 'pyproject.toml'), '[tool.poetry]\nname = "poetry-project"\nversion = "1.0.0"\n');
        const name = await provider.readProjectName(tmpDir);
        expect(name).toBe('poetry-project');
      } finally {
        await rm(tmpDir, { recursive: true });
      }
    });

    it('returns undefined when pyproject.toml has no name field', async () => {
      const tmpDir = await mkdtemp(join(tmpdir(), 'py-provider-test-'));
      try {
        await writeFile(join(tmpDir, 'pyproject.toml'), '[build-system]\nrequires = ["setuptools"]\n');
        const name = await provider.readProjectName(tmpDir);
        expect(name).toBeUndefined();
      } finally {
        await rm(tmpDir, { recursive: true });
      }
    });

    it('returns undefined when only requirements.txt exists (no name concept)', async () => {
      const tmpDir = await mkdtemp(join(tmpdir(), 'py-provider-test-'));
      try {
        await writeFile(join(tmpDir, 'requirements.txt'), 'flask==3.0.0\n');
        const name = await provider.readProjectName(tmpDir);
        expect(name).toBeUndefined();
      } finally {
        await rm(tmpDir, { recursive: true });
      }
    });
  });

  // ─── Tier 1 checks (real python3/ruff/black — never mocked) ────────────

  describe('checkSyntax', () => {
    it('passes for syntactically valid Python', async () => {
      const tmpDir = await mkdtemp(join(tmpdir(), 'py-provider-test-'));
      try {
        const filePath = join(tmpDir, 'valid.py');
        await writeFile(filePath, 'def foo(x):\n    return x + 1\n');
        const result = await provider.checkSyntax(filePath);
        expect(result.ruleId).toBe('NDS-001');
        expect(result.passed).toBe(true);
      } finally {
        await rm(tmpDir, { recursive: true });
      }
    });

    it('fails for invalid Python syntax', async () => {
      const tmpDir = await mkdtemp(join(tmpdir(), 'py-provider-test-'));
      try {
        const filePath = join(tmpDir, 'invalid.py');
        await writeFile(filePath, 'def foo(x:\n    return x\n');
        const result = await provider.checkSyntax(filePath);
        expect(result.passed).toBe(false);
      } finally {
        await rm(tmpDir, { recursive: true });
      }
    });
  });

  describe('formatCode', () => {
    it('formats valid Python source', async () => {
      const tmpDir = await mkdtemp(join(tmpdir(), 'py-provider-test-'));
      try {
        const formatted = await provider.formatCode('def foo(x):\n    return x+1\n', tmpDir);
        expect(formatted).toBe('def foo(x):\n    return x + 1\n');
      } finally {
        await rm(tmpDir, { recursive: true });
      }
    });
  });

  describe('lintCheck', () => {
    it('passes when instrumented code introduces no new formatting violation', async () => {
      const original = 'def foo(x):\n    return x + 1\n';
      const result = await provider.lintCheck(original, original);
      expect(result.ruleId).toBe('LINT');
      expect(result.passed).toBe(true);
    });
  });
});

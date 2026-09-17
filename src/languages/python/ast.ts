// ABOUTME: Python-specific AST helpers: function/import/export finding and OTel detection.
// ABOUTME: Uses tree-sitter-python (via web-tree-sitter) for read-only structural analysis only.

import { Parser, Language, type Node } from 'web-tree-sitter';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type {
  FunctionInfo,
  ImportInfo,
  ExportInfo,
  FunctionClassification,
  InstrumentationDetectionResult,
  DetectedSpanPattern,
} from '../types.ts';

// Resolved relative to this file, not process.cwd() — spiny-orb runs against target
// projects whose working directory is not this package. Works identically from
// src/languages/python/ast.ts (dev) and dist/languages/python/ast.js (published),
// since both sit three directories below the package root.
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../');
const WASM_PATH = join(PACKAGE_ROOT, 'resources/tree-sitter-python.wasm');

// Top-level await: ESM guarantees this module's initialization completes (including
// awaits) before any importer receives its exports, so the synchronous functions
// below can safely assume `parser` is ready. This is what lets an inherently async
// WASM parser satisfy the LanguageProvider interface's synchronous AST method contract.
await Parser.init();
const PythonLanguage = await Language.load(WASM_PATH);
const parser = new Parser();
parser.setLanguage(PythonLanguage);

const SPAN_CREATION_METHODS = new Set(['start_as_current_span', 'start_span']);

/** Whether a `function_definition` node has a leading `async` keyword child. */
function isAsyncFunctionDefinition(fnNode: Node): boolean {
  for (let i = 0; i < fnNode.childCount; i++) {
    if (fnNode.child(i)?.type === 'async') return true;
  }
  return false;
}

function toLine(node: Node): number {
  return node.startPosition.row + 1;
}

/** `parser.parse()` only returns `null` when parsing is aborted (e.g. a timeout); spiny-orb sets neither. */
function parsePython(source: string) {
  const tree = parser.parse(source);
  if (tree === null) throw new Error('tree-sitter-python failed to parse source (parse() returned null)');
  return tree;
}

/**
 * Find all module-level functions and class methods in Python source.
 *
 * Mirrors the JS/TS scope: top-level function definitions and direct class
 * methods are included; functions nested inside another function body, and
 * methods of nested classes, are not (matching ts-morph's `getFunctions()` /
 * `getMethods()` scope, which also does not recurse into function bodies).
 *
 * `isExported` follows Python's naming convention (PRD #373 OD-1 context):
 * a function is public unless its name is prefixed with `_`.
 *
 * @param source - Python source code text
 */
export function findPythonFunctions(source: string): FunctionInfo[] {
  const tree = parsePython(source);
  const functions: FunctionInfo[] = [];

  function collect(stmtNode: Node, insideClass: boolean): void {
    let node = stmtNode;
    let boundaryNode = stmtNode;

    if (node.type === 'decorated_definition') {
      const inner = node.childForFieldName('definition');
      if (inner === null) return;
      boundaryNode = stmtNode;
      node = inner;
    }

    if (node.type === 'function_definition') {
      const nameNode = node.childForFieldName('name');
      const bodyNode = node.childForFieldName('body');
      if (nameNode === null || bodyNode === null) return;

      const name = nameNode.text;
      const startLine = toLine(boundaryNode);
      const endLine = node.endPosition.row + 1;

      functions.push({
        name,
        startLine,
        endLine,
        isExported: !name.startsWith('_'),
        isAsync: isAsyncFunctionDefinition(node),
        lineCount: endLine - startLine + 1,
      });
      return;
    }

    if (node.type === 'class_definition' && !insideClass) {
      const body = node.childForFieldName('body');
      if (body === null) return;
      for (const child of body.namedChildren) {
        if (child !== null) collect(child, true);
      }
    }
  }

  for (const stmt of tree.rootNode.namedChildren) {
    if (stmt !== null) collect(stmt, false);
  }

  tree.delete();
  return functions;
}

/**
 * Find all import statements in Python source.
 *
 * `import a, b as c` (an `import_statement`) produces one `ImportInfo` per
 * module, since each name binds an independent module — there is no shared
 * "from" module the way `from x import a, b` has.
 *
 * `from module import a, b as c` (an `import_from_statement`) produces a
 * single `ImportInfo` per statement: `moduleSpecifier` is the module path,
 * `importedNames` holds every named member (per-name aliases are dropped,
 * matching the JS/TS provider's handling of `import { a as b }`). A wildcard
 * (`from x import *`) yields `importedNames: []`, matching `ImportInfo`'s
 * documented convention for namespace/wildcard imports.
 *
 * Relative imports (`from . import x`, `from ..pkg import y`) use the
 * relative-import node's own text (`.`, `..pkg`) as `moduleSpecifier`.
 *
 * @param source - Python source code text
 */
export function findPythonImports(source: string): ImportInfo[] {
  const tree = parsePython(source);
  const imports: ImportInfo[] = [];

  for (const stmt of tree.rootNode.namedChildren) {
    if (stmt === null) continue;

    if (stmt.type === 'import_statement') {
      for (const nameNode of stmt.childrenForFieldName('name')) {
        if (nameNode === null) continue;
        const lineNumber = toLine(nameNode);
        if (nameNode.type === 'aliased_import') {
          const moduleNode = nameNode.childForFieldName('name');
          const aliasNode = nameNode.childForFieldName('alias');
          if (moduleNode === null) continue;
          imports.push({
            moduleSpecifier: moduleNode.text,
            importedNames: [],
            alias: aliasNode?.text,
            lineNumber,
          });
        } else {
          imports.push({ moduleSpecifier: nameNode.text, importedNames: [], alias: undefined, lineNumber });
        }
      }
      continue;
    }

    if (stmt.type === 'import_from_statement') {
      const moduleNode = stmt.childForFieldName('module_name');
      if (moduleNode === null) continue;

      const hasWildcard = Array.from({ length: stmt.childCount }, (_, i) => stmt.child(i)).some(
        c => c?.type === 'wildcard_import',
      );

      const importedNames: string[] = [];
      if (!hasWildcard) {
        for (const nameNode of stmt.childrenForFieldName('name')) {
          if (nameNode === null) continue;
          if (nameNode.type === 'aliased_import') {
            const originalName = nameNode.childForFieldName('name');
            if (originalName !== null) importedNames.push(originalName.text);
          } else {
            importedNames.push(nameNode.text);
          }
        }
      }

      imports.push({
        moduleSpecifier: moduleNode.text,
        importedNames,
        alias: undefined,
        lineNumber: toLine(stmt),
      });
    }
  }

  tree.delete();
  return imports;
}

/**
 * Find module-level "exported" symbols in Python source.
 *
 * Python has no explicit export syntax (PRD #373 OD-1 context), so this
 * reports module-level function and class definitions whose name is not
 * `_`-prefixed — the same naming convention `findPythonFunctions()` uses
 * for `isExported`. `isDefault` is always `false`: Python has no default-export
 * concept.
 *
 * @param source - Python source code text
 */
export function findPythonExports(source: string): ExportInfo[] {
  const tree = parsePython(source);
  const exports: ExportInfo[] = [];

  for (const stmt of tree.rootNode.namedChildren) {
    if (stmt === null) continue;

    let node = stmt;
    let boundaryNode = stmt;
    if (node.type === 'decorated_definition') {
      const inner = node.childForFieldName('definition');
      if (inner === null) continue;
      boundaryNode = stmt;
      node = inner;
    }

    if (node.type === 'function_definition' || node.type === 'class_definition') {
      const nameNode = node.childForFieldName('name');
      if (nameNode === null) continue;
      if (!nameNode.text.startsWith('_')) {
        exports.push({ name: nameNode.text, lineNumber: toLine(boundaryNode), isDefault: false });
      }
    }
  }

  tree.delete();
  return exports;
}

/**
 * Classify a function's role.
 *
 * Always returns `'unknown'`, matching the TypeScript provider's approach
 * (see `classifyTsFunction`): full classification (e.g. Flask/FastAPI entry
 * point detection per OD-6) requires source-level context that Tier 2
 * checkers (COV-001 etc.) evaluate directly, rather than this per-function
 * structural helper. A checker receiving `'unknown'` abstains.
 */
export function classifyPythonFunction(_fn: FunctionInfo): FunctionClassification {
  return 'unknown';
}

/**
 * Detect whether Python source already contains OTel instrumentation.
 *
 * True if the file imports from an `opentelemetry` module, or contains a
 * `start_as_current_span`/`start_span` call pattern (per OD-1's span-creation
 * detection, independent of how the tracer was obtained).
 *
 * @param source - Python source code text
 */
export function detectPythonExistingInstrumentation(source: string): boolean {
  return detectPythonOTelInstrumentation(source).hasExistingInstrumentation
    || findPythonImports(source).some(imp => imp.moduleSpecifier === 'opentelemetry' || imp.moduleSpecifier.startsWith('opentelemetry.'));
}

/**
 * Detect existing OTel instrumentation in Python source with span-pattern detail.
 *
 * Finds `tracer.start_as_current_span(...)` and `tracer.start_span(...)` call
 * sites (per OD-1), regardless of the receiver's variable name, reporting
 * each pattern's line number and enclosing function (the nearest ancestor
 * `function_definition`, or `undefined` at module scope).
 *
 * @param source - Python source code text
 */
export function detectPythonOTelInstrumentation(source: string): InstrumentationDetectionResult {
  const tree = parsePython(source);
  const spanPatterns: DetectedSpanPattern[] = [];

  function enclosingFunctionName(node: Node): string | undefined {
    let current = node.parent;
    while (current !== null) {
      if (current.type === 'function_definition') {
        return current.childForFieldName('name')?.text;
      }
      current = current.parent;
    }
    return undefined;
  }

  function walk(node: Node): void {
    if (node.type === 'call') {
      const fn = node.childForFieldName('function');
      if (fn?.type === 'attribute') {
        const attribute = fn.childForFieldName('attribute');
        if (attribute !== null && SPAN_CREATION_METHODS.has(attribute.text)) {
          spanPatterns.push({
            patternName: attribute.text,
            lineNumber: toLine(node),
            enclosingFunction: enclosingFunctionName(node),
          });
        }
      }
    }
    for (const child of node.namedChildren) {
      if (child !== null) walk(child);
    }
  }

  walk(tree.rootNode);
  tree.delete();

  return {
    hasExistingInstrumentation: spanPatterns.length > 0,
    spanPatterns,
  };
}

// ABOUTME: NDS-004 Python Tier 2 check — exported function/method signature preservation.
// ABOUTME: Detects when instrumented code adds, removes, or renames parameters on exported functions.

import { type Node, type Tree } from 'web-tree-sitter';
import { parsePython } from '../ast.ts';
import type { CheckResult } from '../../../validation/types.ts';
import type { ValidationRule, RuleInput } from '../../types.ts';

/**
 * Signature info extracted from an exported function or method.
 * Parameter names only — type hints and default values are intentionally not
 * compared, matching JS's and TypeScript's own `nds004.ts` (which strip type
 * annotations and don't track default values either).
 */
interface ExportedSignature {
  name: string;
  params: string[];
  lineNumber: number;
}

function toLine(node: Node): number {
  return node.startPosition.row + 1;
}

/**
 * The comparable name for a single parameter node.
 *
 * Verified directly against the real `tree-sitter-python` grammar (node shapes
 * dumped, not assumed): a plain `identifier` is the whole parameter; `default_parameter`
 * and `typed_default_parameter` both carry a `name` field; `typed_parameter` has no
 * `name` field — its target (identifier, `*args`, or `**kwargs`) is its own first named
 * child; `list_splat_pattern`/`dictionary_splat_pattern` wrap the bound identifier for
 * `*args`/`**kwargs`. Bare `/` and `*` separators (positional-only / keyword-only
 * markers) are included as literal tokens — unlike a type hint or default value, removing
 * one of these is a real calling-convention change and must be caught as a signature diff.
 */
function paramName(node: Node): string | undefined {
  switch (node.type) {
    case 'identifier':
      return node.text;
    case 'default_parameter':
    case 'typed_default_parameter':
      return node.childForFieldName('name')?.text;
    case 'typed_parameter': {
      const inner = node.namedChild(0);
      return inner ? paramName(inner) : undefined;
    }
    case 'list_splat_pattern': {
      const inner = node.namedChild(0);
      return inner ? `*${paramName(inner)}` : undefined;
    }
    case 'dictionary_splat_pattern': {
      const inner = node.namedChild(0);
      return inner ? `**${paramName(inner)}` : undefined;
    }
    case 'positional_separator':
      return '/';
    case 'keyword_separator':
      return '*';
    default:
      return undefined;
  }
}

/** Extract the comparable parameter-name list from a `function_definition`'s `parameters` node. */
function extractParams(fnNode: Node): string[] {
  const paramsNode = fnNode.childForFieldName('parameters');
  if (paramsNode === null) return [];
  const names: string[] = [];
  for (const child of paramsNode.namedChildren) {
    if (child === null) continue;
    const name = paramName(child);
    if (name !== undefined) names.push(name);
  }
  return names;
}

/**
 * Find exported (per PRD #373 OD-1: not `_`-prefixed) function/method signatures.
 *
 * Scope mirrors `findPythonFunctions()` in `ast.ts`: top-level functions and direct
 * class methods, including one defined conditionally inside a module-level compound
 * statement (`if`/`elif`/`else`, `try`/`except`, `while`, `for`, `with`); does not
 * descend into nested functions or nested classes' methods. Unlike JS's and
 * TypeScript's own `nds004.ts` (which only ever extract top-level exported functions,
 * never class methods), Python's does extract class methods — so a bare method-name
 * key would silently collapse two different classes' same-named methods into one
 * entry, dropping the second from comparison entirely rather than merely picking one.
 * `ExportedSignature.name` is therefore class-qualified as `ClassName.methodName` for
 * a method, and left as the bare name for a top-level function; `_`-prefix export
 * detection still checks the bare method name, per OD-1's naming convention.
 */
function extractExportedSignatures(code: string): { tree: Tree; signatures: ExportedSignature[] } {
  const tree = parsePython(code);
  const signatures: ExportedSignature[] = [];
  const seen = new Set<string>();

  function collect(stmtNode: Node, className: string | undefined): void {
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
      if (nameNode === null) return;
      const name = nameNode.text;
      if (name.startsWith('_')) return; // Not exported, per OD-1's naming convention.
      const qualifiedName = className !== undefined ? `${className}.${name}` : name;
      if (seen.has(qualifiedName)) return;
      seen.add(qualifiedName);
      signatures.push({
        name: qualifiedName,
        params: extractParams(node),
        lineNumber: toLine(boundaryNode),
      });
      return;
    }

    if (node.type === 'class_definition') {
      if (className !== undefined) return; // Nested class — don't recurse into its methods.
      const nameNode = node.childForFieldName('name');
      const classNameText = nameNode?.text;
      const body = node.childForFieldName('body');
      if (body === null || classNameText === undefined) return;
      for (const child of body.namedChildren) {
        if (child !== null) collect(child, classNameText);
      }
      return;
    }

    // Descend into compound statements to find a conditionally-defined function
    // or method, matching `findPythonFunctions()`'s own recursion.
    for (const child of node.namedChildren) {
      if (child !== null) collect(child, className);
    }
  }

  for (const stmt of tree.rootNode.namedChildren) {
    if (stmt !== null) collect(stmt, undefined);
  }

  return { tree, signatures };
}

/**
 * NDS-004 Python: Verify exported function/method signatures are preserved after
 * instrumentation.
 *
 * Compares the parameter-name lists (positional-only/keyword-only separators
 * included, type hints and default values excluded) of all exported functions
 * and direct class methods in the original code against the instrumented output.
 * Flags:
 * - Parameters added, removed, or renamed
 * - A positional-only (`/`) or keyword-only (`*`) marker added or removed
 * - Exported functions/methods removed entirely
 *
 * Blocking — parameter list comparison is direct equality with no heuristics or
 * fuzzy matching, matching JS's and TypeScript's own NDS-004 disposition.
 *
 * @param originalCode - The original source code before instrumentation
 * @param instrumentedCode - The agent's instrumented output
 * @param filePath - Path to the file being validated (for CheckResult)
 * @returns CheckResult[] — one per mismatch, or a single passing result
 */
export function checkPythonSignaturePreservation(
  originalCode: string,
  instrumentedCode: string,
  filePath: string,
): CheckResult[] {
  const { tree: originalTree, signatures: originalSigs } = extractExportedSignatures(originalCode);
  originalTree.delete();

  const { tree: instrumentedTree, signatures: instrumentedSigs } = extractExportedSignatures(instrumentedCode);
  instrumentedTree.delete();

  // No exported functions/methods in original — nothing to violate.
  if (originalSigs.length === 0) {
    return [passingResult(filePath)];
  }

  const instrumentedByName = new Map<string, ExportedSignature>();
  for (const sig of instrumentedSigs) {
    instrumentedByName.set(sig.name, sig);
  }

  const violations: CheckResult[] = [];

  for (const origSig of originalSigs) {
    const instrSig = instrumentedByName.get(origSig.name);

    if (!instrSig) {
      violations.push({
        ruleId: 'NDS-004',
        passed: false,
        filePath,
        lineNumber: null,
        message:
          `NDS-004: Exported function "${origSig.name}" is missing from instrumented output. ` +
          `Original signature: ${origSig.name}(${origSig.params.join(', ')}). ` +
          `Instrumentation must preserve all exported functions and their signatures.`,
        tier: 2,
        blocking: true,
      });
      continue;
    }

    const origParams = origSig.params;
    const instrParams = instrSig.params;

    if (origParams.length !== instrParams.length ||
        origParams.some((p, i) => p !== instrParams[i])) {
      violations.push({
        ruleId: 'NDS-004',
        passed: false,
        filePath,
        lineNumber: instrSig.lineNumber,
        message:
          `NDS-004: Exported function "${origSig.name}" signature changed. ` +
          `Original: ${origSig.name}(${origParams.join(', ')}), ` +
          `instrumented: ${origSig.name}(${instrParams.join(', ')}). ` +
          `Instrumentation must not add, remove, or rename parameters on exported functions.`,
        tier: 2,
        blocking: true,
      });
    }
  }

  if (violations.length === 0) {
    return [passingResult(filePath)];
  }

  return violations;
}

function passingResult(filePath: string): CheckResult {
  return {
    ruleId: 'NDS-004',
    passed: true,
    filePath,
    lineNumber: null,
    message: 'Exported function signatures preserved. All exported functions maintain their original parameter lists.',
    tier: 2,
    blocking: true,
  };
}

/** NDS-004 Python ValidationRule — exported function/method signatures must be preserved. */
export const nds004PythonRule: ValidationRule = {
  ruleId: 'NDS-004',
  dimension: 'Non-destructive',
  blocking: true,
  applicableTo(language: string): boolean {
    return language === 'python';
  },
  check(input: RuleInput): CheckResult[] {
    return checkPythonSignaturePreservation(input.originalCode, input.instrumentedCode, input.filePath);
  },
};

// ABOUTME: CDQ-012 Python Tier 2 blocking check — every tracer and trace name a file uses is bound.
// ABOUTME: Catches a NameError at runtime when output uses tracer or trace without importing or assigning it.

import { type Node } from 'web-tree-sitter';
import { parsePython } from '../ast.ts';
import type { CheckResult } from '../../../validation/types.ts';
import type { ValidationRule, RuleInput } from '../../types.ts';

/** The two names generated instrumentation relies on that the rest of the file may not define. */
const TRACKED_NAMES = new Set(['tracer', 'trace']);

/** Node types that open their own scope for the loop variables they bind. */
const COMPREHENSION_TYPES = new Set(['list_comprehension', 'set_comprehension', 'dictionary_comprehension', 'generator_expression']);

/** Marker stored in a scope when a wildcard import makes every name in it unknowable. */
const WILDCARD = '*';

interface Scope {
  names: Set<string>;
  /** Class bodies bind names for the body itself, never for the methods nested in them. */
  isClass: boolean;
}

interface NameUse {
  name: string;
  startIndex: number;
  line: number;
  scopes: Scope[];
}

type Role = 'binding' | 'skip' | 'use';

function sameNode(a: Node | null, b: Node): boolean {
  return a !== null && a.startIndex === b.startIndex && a.endIndex === b.endIndex;
}

/**
 * Decide what an identifier named `tracer` or `trace` is doing from its parent node:
 * binding the name, merely spelling it (an attribute name or keyword argument name is not
 * a reference to the variable), or reading it. Nodes are compared by position because
 * web-tree-sitter builds a fresh wrapper for every access.
 */
function classifyIdentifier(node: Node): Role {
  const parent = node.parent;
  if (parent === null) return 'use';
  switch (parent.type) {
    case 'attribute':
      return sameNode(parent.childForFieldName('attribute'), node) ? 'skip' : 'use';
    case 'keyword_argument':
      return sameNode(parent.childForFieldName('name'), node) ? 'skip' : 'use';
    case 'parameters':
    case 'lambda_parameters':
    case 'typed_parameter':
    case 'list_splat_pattern':
    case 'dictionary_splat_pattern':
    case 'pattern_list':
    case 'tuple_pattern':
    case 'list_pattern':
    case 'as_pattern_target':
      return 'binding';
    case 'default_parameter':
    case 'typed_default_parameter':
      return sameNode(parent.childForFieldName('name'), node) ? 'binding' : 'use';
    case 'assignment':
      return sameNode(parent.childForFieldName('left'), node) ? 'binding' : 'use';
    case 'for_statement':
    case 'for_in_clause':
      return sameNode(parent.childForFieldName('left'), node) ? 'binding' : 'use';
    case 'named_expression':
      return sameNode(parent.childForFieldName('name'), node) ? 'binding' : 'use';
    case 'function_definition':
    case 'class_definition':
    case 'global_statement':
    case 'nonlocal_statement':
      return 'skip';
    default:
      return 'use';
  }
}

/**
 * Names an import statement binds. `import a.b` binds `a`; `import a.b as c` and
 * `from a import b as c` bind only the alias; `from a import b` binds `b`. A wildcard
 * import can bind anything, so it is recorded as a wildcard rather than guessed at.
 */
function importedNames(stmt: Node): string[] {
  const names: string[] = [];
  for (const entry of stmt.childrenForFieldName('name')) {
    if (entry === null) continue;
    if (entry.type === 'aliased_import') {
      const alias = entry.childForFieldName('alias');
      if (alias !== null) names.push(alias.text);
    } else if (entry.type === 'dotted_name') {
      names.push(stmt.type === 'import_statement' ? (entry.namedChildren[0]?.text ?? entry.text) : entry.text);
    }
  }
  if (stmt.namedChildren.some(child => child !== null && child.type === 'wildcard_import')) names.push(WILDCARD);
  return names;
}

function isBound(use: NameUse): boolean {
  const innermost = use.scopes.length - 1;
  return use.scopes.some((scope, index) => {
    if (scope.isClass && index !== innermost) return false;
    return scope.names.has(use.name) || scope.names.has(WILDCARD);
  });
}

/**
 * Walk the tree once, recording every reference to a tracked name together with the scopes that
 * can see it. Two approximations lean toward treating a name as bound, so neither can invent a
 * finding: a default parameter value and a comprehension's first iterable are evaluated in the
 * enclosing scope in Python but are walked here inside the new scope.
 */
function collectUses(root: Node): NameUse[] {
  const moduleScope: Scope = { names: new Set(), isClass: false };
  const uses: NameUse[] = [];

  function walk(node: Node, scopes: Scope[]): void {
    const current = scopes[scopes.length - 1];

    if (node.type === 'import_statement' || node.type === 'import_from_statement') {
      for (const name of importedNames(node)) current.names.add(name);
      return;
    }

    // A `global` declaration lets a function bind the module-level name, so it counts as a
    // module binding wherever it appears (the alternative is a false positive on a valid file).
    if (node.type === 'global_statement') {
      for (const child of node.namedChildren) {
        if (child !== null && child.type === 'identifier' && TRACKED_NAMES.has(child.text)) moduleScope.names.add(child.text);
      }
      return;
    }

    if (node.type === 'identifier') {
      if (!TRACKED_NAMES.has(node.text)) return;
      const role = classifyIdentifier(node);
      if (role === 'binding') current.names.add(node.text);
      else if (role === 'use') uses.push({ name: node.text, startIndex: node.startIndex, line: node.startPosition.row + 1, scopes: [...scopes] });
      return;
    }

    if (node.type === 'function_definition' || node.type === 'class_definition' || node.type === 'lambda') {
      const nameNode = node.type === 'lambda' ? null : node.childForFieldName('name');
      if (nameNode !== null && TRACKED_NAMES.has(nameNode.text)) current.names.add(nameNode.text);
      const inner: Scope = { names: new Set(), isClass: node.type === 'class_definition' };
      for (const child of node.namedChildren) {
        if (child === null || sameNode(nameNode, child)) continue;
        walk(child, [...scopes, inner]);
      }
      return;
    }

    // A comprehension's loop variable is visible only inside it, and (like a function) it
    // cannot see names bound in an enclosing class body.
    const inner = COMPREHENSION_TYPES.has(node.type) ? [...scopes, { names: new Set<string>(), isClass: false }] : scopes;
    for (const child of node.namedChildren) {
      if (child !== null) walk(child, inner);
    }
  }

  walk(root, [moduleScope]);
  return uses;
}

function messageFor(name: string, line: number): string {
  if (name === 'trace') {
    return `CDQ-012: \`trace\` is used at line ${line} but is never imported or assigned in this file. Add \`from opentelemetry import trace\` with the file's other imports.`;
  }
  return `CDQ-012: \`tracer\` is used at line ${line} but is never imported or assigned in this file. Add a module-level \`tracer = trace.get_tracer('service-name')\`, using the tracer name from your instructions (and \`from opentelemetry import trace\` if \`trace\` is not already imported) before the code that uses it.`;
}

/**
 * CDQ-012 Python: Verify that every use of `tracer` or `trace` in the file is bound by an
 * import, an assignment, a parameter, or a definition in a scope that can see the use.
 *
 * Reassembling a function into a file is a pure splice, so if the model returns a function
 * without the tracer setup its prompt requires, the result compiles, lints clean and passes
 * every other check, then raises NameError when the function runs. This rule reports that
 * case for the whole file, so it covers a splice and a whole-file rewrite alike.
 *
 * Reports one finding per unbound name, at its first unbound use, to keep the feedback
 * short. Binding detection errs toward treating a name as bound (wildcard imports and
 * `global` declarations count) because a false positive blocks a valid file.
 *
 * @param code - The instrumented Python code to check
 * @param filePath - Path to the file being validated (for CheckResult)
 * @returns CheckResult[] — one per unbound name, or a single passing result
 */
export function checkPythonTracerBound(code: string, filePath: string): CheckResult[] {
  const tree = parsePython(code);
  let unbound: NameUse[];
  try {
    const firstUnbound = new Map<string, NameUse>();
    for (const use of collectUses(tree.rootNode).sort((a, b) => a.startIndex - b.startIndex)) {
      if (!firstUnbound.has(use.name) && !isBound(use)) firstUnbound.set(use.name, use);
    }
    unbound = [...firstUnbound.values()];
  } finally {
    tree.delete();
  }

  if (unbound.length === 0) {
    return [{
      ruleId: 'CDQ-012',
      passed: true,
      filePath,
      lineNumber: null,
      message: 'Every tracer and trace name used is imported or assigned.',
      tier: 2,
      blocking: true,
    }];
  }

  return unbound.map(use => ({
    ruleId: 'CDQ-012' as const,
    passed: false as const,
    filePath,
    lineNumber: use.line,
    message: messageFor(use.name, use.line),
    tier: 2 as const,
    blocking: true as const,
  }));
}

/** CDQ-012 Python ValidationRule — unbound tracer/trace name blocking check. */
export const cdq012PythonRule: ValidationRule = {
  ruleId: 'CDQ-012',
  dimension: 'Code Quality',
  blocking: true,
  applicableTo(language: string): boolean {
    return language === 'python';
  },
  check(input: RuleInput): CheckResult[] {
    return checkPythonTracerBound(input.instrumentedCode, input.filePath);
  },
};

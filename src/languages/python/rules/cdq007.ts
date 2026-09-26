// ABOUTME: CDQ-007 Python Tier 2 advisory check — attribute data quality.
// ABOUTME: Flags PII attribute names and filesystem path values (see D-CDQ007-1 for the nullable-access sub-check's exclusion).

import { type Node } from 'web-tree-sitter';
import { parsePython } from '../ast.ts';
import type { CheckResult } from '../../../validation/types.ts';
import type { ValidationRule, RuleInput } from '../../types.ts';

/** PII-sensitive attribute names — flagged when the full key matches exactly. Mirrors JS's own `PII_ATTRIBUTE_NAMES`. */
const PII_ATTRIBUTE_NAMES = new Set([
  'author', 'committer', 'username', 'email', 'password', 'ssn', 'name', 'user',
]);

/**
 * PII names specific enough to flag as the last segment of a dotted key
 * (e.g. `"commit.author"` -> `"author"` flagged). `"name"`/`"user"` are
 * excluded here (they appear in legitimate non-PII OTel keys like
 * `service.name`) but are still caught when the full key matches exactly.
 * Mirrors JS's own `PII_SUFFIX_NAMES`.
 */
const PII_SUFFIX_NAMES = new Set(['author', 'committer', 'username', 'email', 'password', 'ssn']);

/** Identifier token segments that indicate a filesystem path value. Mirrors JS's own `PATH_IDENTIFIER_PATTERNS`. */
const PATH_IDENTIFIER_PATTERNS = ['path', 'dir', 'file'];

/**
 * All-lowercase compound identifiers that are well-known path identifiers but
 * don't split at token boundaries. Mirrors JS's own `PATH_COMPOUND_TOKENS`.
 */
const PATH_COMPOUND_TOKENS = new Set(['filepath', 'filename', 'dirname', 'pathname']);

/** Known non-span APIs with a `.set_attribute()` method — never treated as a span receiver. */
const NON_SPAN_RECEIVERS = new Set(['element', 'node', 'document', 'headers', 'attributes', 'config']);

/** Whether a receiver expression is likely a span variable — requires the name to contain "span". Mirrors JS's own `isSpanReceiver()`. */
function isSpanReceiver(receiverText: string): boolean {
  const parts = receiverText.split('.');
  const name = parts[parts.length - 1].toLowerCase();
  if (NON_SPAN_RECEIVERS.has(name)) return false;
  return /span/i.test(name);
}

/** The literal string value of a `string` node, stripping Python's quote/prefix characters. */
function stringLiteralValue(node: Node): string | undefined {
  if (node.type !== 'string') return undefined;
  // Strip an optional string prefix (f/r/b/u, any case/combination) and the quote characters.
  return node.text.replace(/^[a-zA-Z]*(['"]{1,3})/, '').replace(/(['"]{1,3})$/, '');
}

function toLine(node: Node): number {
  return node.startPosition.row + 1;
}

/**
 * CDQ-007 Python: Flag `set_attribute()` calls with data quality issues.
 *
 * Detects two categories, ported directly from JS's own CDQ-007:
 * 1. PII attribute names — keys like `author`, `email`, `username` expose PII in telemetry.
 * 2. Filesystem path values — identifier names containing `path`/`dir`/`file` likely hold
 *    absolute paths that are high-cardinality and expose developer environment details.
 *
 * A third sub-check exists in JS (nullable member access via optional chaining)
 * that has no Python equivalent and is deliberately not ported here — see
 * Decision D-CDQ007-1 for the full rationale.
 *
 * Advisory (`blocking: false`), matching JS's own CDQ-007 disposition.
 *
 * @param code - The instrumented Python code to check
 * @param filePath - Path to the file being validated (for CheckResult)
 * @returns CheckResult[] — one per finding (or a single passing result)
 */
export function checkPythonAttributeDataQuality(code: string, filePath: string): CheckResult[] {
  const tree = parsePython(code);
  const findings: Array<{ line: number; message: string }> = [];

  function walk(node: Node): void {
    if (node.type === 'call') {
      const fn = node.childForFieldName('function');
      if (fn?.type === 'attribute' && fn.childForFieldName('attribute')?.text === 'set_attribute') {
        const receiver = fn.childForFieldName('object');
        const args = node.childForFieldName('arguments');
        const keyArg = args?.namedChild(0);
        const valueArg = args?.namedChild(1);
        const line = toLine(node);

        if (receiver !== null && receiver !== undefined && isSpanReceiver(receiver.text)
          && keyArg !== undefined && keyArg !== null && valueArg !== undefined && valueArg !== null) {
          // Check 1: PII attribute name — only for statically known string keys.
          const keyText = stringLiteralValue(keyArg);
          if (keyText !== undefined) {
            const keySegments = keyText.split('.');
            const lastSegment = keySegments[keySegments.length - 1] ?? '';
            if (PII_ATTRIBUTE_NAMES.has(keyText) || PII_SUFFIX_NAMES.has(lastSegment)) {
              findings.push({
                line,
                message:
                  `set_attribute key "${keyText}" at line ${line} may expose PII in telemetry. ` +
                  `Remove this attribute or rename the key to a non-identifying name.`,
              });
            } else {
              checkPathValue(valueArg, keyText, line, findings);
            }
          } else {
            checkPathValue(valueArg, undefined, line, findings);
          }
        }
      }
    }
    for (const child of node.namedChildren) {
      if (child !== null) walk(child);
    }
  }

  walk(tree.rootNode);
  tree.delete();

  if (findings.length === 0) {
    return [{
      ruleId: 'CDQ-007',
      passed: true,
      filePath,
      lineNumber: null,
      message: 'No PII attribute names or filesystem paths detected.',
      tier: 2,
      blocking: false,
    }];
  }

  return findings.map((f) => ({
    ruleId: 'CDQ-007' as const,
    passed: false as const,
    filePath,
    lineNumber: f.line,
    message: `CDQ-007: ${f.message}`,
    tier: 2 as const,
    blocking: false as const,
  }));
}

/**
 * Check 2: Filesystem path value — value is a bare identifier whose name
 * suggests a path. OTel `file.*` semantic convention attributes expect a
 * full path and are exempt (see JS's own equivalent exemption).
 */
function checkPathValue(
  valueArg: Node,
  keyText: string | undefined,
  line: number,
  findings: Array<{ line: number; message: string }>,
): void {
  if (valueArg.type !== 'identifier') return;

  const tokens = valueArg.text
    .split(/(?<=[a-z])(?=[A-Z])|[_\-.]/)
    .map(t => t.toLowerCase())
    .filter(t => t.length > 0);

  const looksLikePath = PATH_IDENTIFIER_PATTERNS.some(p => tokens.includes(p))
    || tokens.some(t => PATH_COMPOUND_TOKENS.has(t));
  if (!looksLikePath) return;

  if (keyText?.startsWith('file.')) return;

  findings.push({
    line,
    message:
      `set_attribute value "${valueArg.text}" at line ${line} appears to be a filesystem path. ` +
      `Absolute paths are high-cardinality and expose developer environment details. ` +
      `Use a relative path or a derived attribute (e.g., basename) instead.`,
  });
}

/** CDQ-007 Python ValidationRule — set_attribute data quality advisory check. */
export const cdq007PythonRule: ValidationRule = {
  ruleId: 'CDQ-007',
  dimension: 'Code Quality',
  blocking: false,
  applicableTo(language: string): boolean {
    return language === 'python';
  },
  check(input: RuleInput): CheckResult[] {
    return checkPythonAttributeDataQuality(input.instrumentedCode, input.filePath);
  },
};

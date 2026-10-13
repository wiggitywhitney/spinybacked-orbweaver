// ABOUTME: JavaScript-specific Tier 1 validation: syntax checking (node --check) and lint checking (Prettier).
// ABOUTME: Merged from src/validation/tier1/syntax.ts and src/validation/tier1/lint.ts.

import { execFileSync } from 'node:child_process';
import * as prettier from 'prettier';
import type { CheckResult } from '../../validation/types.ts';

// ─── syntax (checkSyntax) ─────────────────────────────────────────────────────

/**
 * Parse a line number from node --check stderr output.
 * Node.js reports syntax errors in the format: "filepath:lineNumber"
 *
 * @param stderr - The stderr output from node --check
 * @param filePath - The file path to match against
 * @returns The line number if found, null otherwise
 */
function parseLineNumber(stderr: string, filePath: string): number | null {
  // Node reports errors like: /path/to/file.js:3
  // Try to extract the line number from the first matching line
  const escapedPath = filePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const lineMatch = stderr.match(new RegExp(`${escapedPath}:(\\d+)`));
  if (lineMatch) {
    return parseInt(lineMatch[1], 10);
  }

  return null;
}

/**
 * Run `node --check` on a file to validate JavaScript syntax.
 *
 * The file must already exist on disk at the given path. This checker
 * does NOT write files — the caller (or fix loop) is responsible for
 * writing instrumented code to the file path before calling this.
 *
 * @param filePath - Absolute path to the file to syntax-check
 * @returns CheckResult with ruleId "NDS-001", tier 1, blocking true
 */
export function checkSyntax(filePath: string): CheckResult {
  try {
    execFileSync('node', ['--check', filePath], {
      timeout: 10_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    return {
      ruleId: 'NDS-001',
      passed: true,
      filePath,
      lineNumber: null,
      message: 'Syntax check passed (node --check exit code 0).',
      tier: 1,
      blocking: true,
    };
  } catch (error: unknown) {
    const stderr =
      error !== null &&
      typeof error === 'object' &&
      'stderr' in error &&
      error.stderr instanceof Buffer
        ? error.stderr.toString()
        : error instanceof Error
          ? error.message
          : String(error);

    const lineNumber = parseLineNumber(stderr, filePath);

    return {
      ruleId: 'NDS-001',
      passed: false,
      filePath,
      lineNumber,
      message:
        `NDS-001 check failed: node --check returned a non-zero exit code. ${stderr.trim()} ` +
        `Fix the syntax error${lineNumber ? ` at line ${lineNumber}` : ''} and ensure the file is valid JavaScript.`,
      tier: 1,
      blocking: true,
    };
  }
}

// ─── lint (checkLint) ─────────────────────────────────────────────────────────

export type DiffOp = { kind: ' ' | '-' | '+'; text: string };

/**
 * Edit-count cap for diffLineOps. The search keeps state proportional to the
 * square of the edit count, so a whole-file reformat of a large file would
 * otherwise need hundreds of megabytes. 2,000 edits bounds it to a few
 * million integers, well beyond the 200-line diff the LINT message shows.
 */
const MAX_DIFF_EDITS = 2000;

/**
 * Line-aligned edit script from `a` to `b` (Myers' O((N+M)D) algorithm).
 * Lines shared by both sides stay aligned even after one side gains or loses
 * a line, so an inserted or split line produces one hunk rather than offsetting
 * every later line. When the changed region needs more than `maxEdits` edits,
 * the search stops and that region is returned as one block of removals followed
 * by additions — still a correct edit script, just not a minimal one.
 * Exported for tests.
 */
export function diffLineOps(a: string[], b: string[], maxEdits = MAX_DIFF_EDITS): DiffOp[] {
  // Trim the common prefix and suffix so the search covers only the changed middle.
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < a.length - prefix && suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) suffix++;
  const midA = a.slice(prefix, a.length - suffix);
  const midB = b.slice(prefix, b.length - suffix);

  const n = midA.length;
  const m = midB.length;
  const offset = n + m;
  const v = new Int32Array(2 * offset + 2);
  // trace[d] holds v[-d..d] as it stood before step d, for backtracking.
  const trace: Int32Array[] = [];
  let found = n === 0 && m === 0;
  for (let d = 0; d <= Math.min(offset, maxEdits) && !found; d++) {
    trace.push(v.slice(offset - d, offset + d + 1));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])
        ? v[offset + k + 1]
        : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && midA[x] === midB[y]) { x++; y++; }
      v[offset + k] = x;
      if (x >= n && y >= m) { found = true; break; }
    }
  }

  const commonPrefix = a.slice(0, prefix).map(text => ({ kind: ' ' as const, text }));
  const commonSuffix = a.slice(a.length - suffix).map(text => ({ kind: ' ' as const, text }));
  if (!found) {
    return [
      ...commonPrefix,
      ...midA.map(text => ({ kind: '-' as const, text })),
      ...midB.map(text => ({ kind: '+' as const, text })),
      ...commonSuffix,
    ];
  }

  const middle: DiffOp[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d > 0; d--) {
    const prev = trace[d];
    const at = (k: number): number => prev[k + d];
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { middle.push({ kind: ' ', text: midA[x - 1] }); x--; y--; }
    if (x === prevX) middle.push({ kind: '+', text: midB[y - 1] });
    else middle.push({ kind: '-', text: midA[x - 1] });
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) { middle.push({ kind: ' ', text: midA[x - 1] }); x--; y--; }
  middle.reverse();

  return [...commonPrefix, ...middle, ...commonSuffix];
}

/**
 * Within each run of consecutive changes, pair the i-th removed line with the
 * i-th added line. A long replacement then shows each line next to its
 * reformatted version, and a truncated diff still shows the first pair.
 */
function interleaveChangeBlocks(ops: DiffOp[]): DiffOp[] {
  const result: DiffOp[] = [];
  let i = 0;
  while (i < ops.length) {
    if (ops[i].kind === ' ') { result.push(ops[i]); i++; continue; }
    const removed: DiffOp[] = [];
    const added: DiffOp[] = [];
    while (i < ops.length && ops[i].kind !== ' ') {
      (ops[i].kind === '-' ? removed : added).push(ops[i]);
      i++;
    }
    for (let j = 0; j < Math.max(removed.length, added.length); j++) {
      if (j < removed.length) result.push(removed[j]);
      if (j < added.length) result.push(added[j]);
    }
  }
  return result;
}

/**
 * Compute a compact context diff between two strings.
 * Lines are aligned before comparison, so a line Prettier splits in two shows
 * as one hunk instead of offsetting every following line. Hunks are emitted in
 * file order, so truncation never drops the first real difference.
 */
function buildPrettierDiff(before: string, after: string): string {
  const CONTEXT = 2;
  const MAX_DIFF_LINES = 200;
  const ops = interleaveChangeBlocks(diffLineOps(before.split('\n'), after.split('\n')));

  const include = new Set<number>();
  for (let i = 0; i < ops.length; i++) {
    if (ops[i].kind === ' ') continue;
    for (let c = Math.max(0, i - CONTEXT); c <= Math.min(ops.length - 1, i + CONTEXT); c++) {
      include.add(c);
    }
  }
  if (include.size === 0) return '';

  const output: string[] = [];
  let lastIdx = -2;
  for (let i = 0; i < ops.length; i++) {
    if (!include.has(i)) continue;
    if (output.length >= MAX_DIFF_LINES) {
      output.push('... (diff truncated)');
      break;
    }
    if (lastIdx >= 0 && i > lastIdx + 1) output.push('...');
    output.push(`${ops[i].kind}${ops[i].text}`);
    lastIdx = i;
  }
  return output.join('\n');
}

/**
 * Check if code matches the project's Prettier configuration.
 * Resolves config from the file path to respect .prettierrc.
 *
 * @param code - The code to check
 * @param filePath - File path for config resolution
 * @returns Whether the code is Prettier-compliant
 */
async function isPrettierCompliant(code: string, filePath: string): Promise<boolean> {
  const config = await prettier.resolveConfig(filePath);
  return prettier.check(code, { ...config, filepath: filePath });
}

/**
 * Run diff-based lint checking on original and instrumented code.
 *
 * Uses Prettier's boolean check (compliant vs not) on both the original
 * and instrumented files. Only flags a failure when the agent *introduced*
 * a formatting violation — pre-existing non-compliance is not penalized.
 *
 * Decision matrix:
 * - Original compliant, output compliant → PASS
 * - Original compliant, output non-compliant → FAIL (agent broke formatting)
 * - Original non-compliant, output non-compliant → PASS (not a new error)
 * - Original non-compliant, output compliant → PASS (agent improved formatting)
 *
 * @param originalCode - The original file content before instrumentation
 * @param instrumentedCode - The agent's instrumented output
 * @param filePath - File path for Prettier config resolution
 * @returns CheckResult with ruleId "LINT", tier 1, blocking true
 */
export async function checkLint(
  originalCode: string,
  instrumentedCode: string,
  filePath: string,
): Promise<CheckResult> {
  try {
    const originalCompliant = await isPrettierCompliant(originalCode, filePath);
    const outputCompliant = await isPrettierCompliant(instrumentedCode, filePath);

    // Only fail when agent introduced a formatting violation
    if (originalCompliant && !outputCompliant) {
      // Build a diff showing what Prettier expects — best-effort, failure produces no diff section
      let diffSection = '';
      let configNote = '';
      try {
        const config = await prettier.resolveConfig(filePath);
        const configFilePath = await prettier.resolveConfigFile(filePath);
        const formatted = await prettier.format(instrumentedCode, { ...config, filepath: filePath });
        const diff = buildPrettierDiff(instrumentedCode, formatted);
        if (diff) {
          diffSection =
            `\n\nPrettier would reformat your output as follows — regenerate the file with these changes applied:\n` +
            `\`\`\`diff\n${diff}\n\`\`\``;
        }
        if (configFilePath) {
          configNote = ` Prettier config: ${configFilePath}.`;
        }
      } catch {
        // Diff generation is best-effort; a failure here does not affect the check result
      }

      return {
        ruleId: 'LINT',
        passed: false,
        filePath,
        lineNumber: null,
        message:
          `LINT check failed: the original file was Prettier-compliant but the instrumented output is not.${configNote} ` +
          `The agent introduced formatting violations. ` +
          `LINT is blocking: this file cannot be committed until the output is Prettier-compliant.` +
          diffSection,
        tier: 1,
        blocking: true,
      };
    }

    return {
      ruleId: 'LINT',
      passed: true,
      filePath,
      lineNumber: null,
      message: originalCompliant
        ? 'Lint check passed: output matches Prettier configuration.'
        : outputCompliant
          ? 'Lint check passed: output is Prettier-compliant and improves on a non-compliant original.'
          : 'Lint check passed: original was not Prettier-compliant, so non-compliance in output is not a new error.',
      tier: 1,
      blocking: true,
    };
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ruleId: 'LINT',
      passed: false,
      filePath,
      lineNumber: null,
      message: `LINT check failed: Prettier encountered an error. ${detail}`,
      tier: 1,
      blocking: true,
    };
  }
}

/**
 * Format JavaScript source code using Prettier.
 *
 * Returns the formatted source. If Prettier is not available or formatting
 * fails, returns the original source unchanged.
 *
 * @param source - Source code text to format
 * @param configDir - Directory to search for Prettier config files
 * @returns Formatted source, or original source if formatting fails
 */
export async function formatCode(source: string, filePath: string): Promise<string> {
  try {
    const config = await prettier.resolveConfig(filePath);
    // No explicit parser: Prettier infers it from filePath, exactly as checkLint does,
    // so formatted output is checked with the parser that produced it.
    return await prettier.format(source, {
      ...config,
      filepath: filePath,
    });
  } catch {
    return source;
  }
}

/**
 * Prettier option defaults (v3). Used to detect non-default settings that
 * affect agent-generated code and should be injected into the prompt.
 */
const PRETTIER_DEFAULTS: Record<string, unknown> = {
  arrowParens: 'always',
  printWidth: 80,
  semi: true,
  singleQuote: false,
  trailingComma: 'all',
};

/**
 * Build a compact prose constraint string describing non-default Prettier
 * formatting rules for a file. Injected into the instrumentation prompt so
 * the agent generates compliant code on the first attempt rather than
 * relying on fix-loop corrections.
 *
 * Returns an empty string when no config exists or all relevant options
 * match Prettier defaults — no noise for default-config projects.
 *
 * Only covers options that affect agent-generated code (arrow functions,
 * line length, semicolons, quotes, trailing commas). Options like tabWidth
 * and useTabs are excluded — the agent wraps existing code in spans and
 * does not control indentation.
 *
 * @param filePath - Absolute path to the file being instrumented
 * @returns Constraint prose string, or empty string if nothing to inject
 */
export async function buildPrettierConstraint(filePath: string): Promise<string> {
  let config: Record<string, unknown> | null;
  try {
    config = await prettier.resolveConfig(filePath) as Record<string, unknown> | null;
  } catch {
    return '';
  }

  if (!config) return '';

  const nonDefault: string[] = [];

  for (const [key, defaultValue] of Object.entries(PRETTIER_DEFAULTS)) {
    if (key in config && config[key] !== defaultValue) {
      nonDefault.push(`${key}: ${config[key]}`);
    }
  }

  if (nonDefault.length === 0) return '';

  const rules = nonDefault.join(', ');
  const parts: string[] = [`This project's Prettier config enforces: ${rules}.`];

  const arrowParens = config['arrowParens'];
  if (arrowParens === 'avoid') {
    parts.push('Write all arrow functions without parentheses around single parameters (e.g., `async span => {` not `async (span) => {`).');
  }

  const printWidth = config['printWidth'];
  if (typeof printWidth === 'number' && printWidth !== PRETTIER_DEFAULTS['printWidth']) {
    parts.push(`Keep generated lines under ${printWidth} characters to avoid Prettier line-wrap reformatting.`);
  }

  return parts.join(' ');
}

// ABOUTME: Python-specific Tier 1 validation: syntax checking (python3 compile()) and formatter checking (Ruff/Black).
// ABOUTME: Mirrors javascript/validation.ts and typescript/validation.ts, but formats via Ruff-first/Black-fallback per OD-2.

import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import type { CheckResult } from '../../validation/types.ts';

// ─── syntax (checkSyntax) ─────────────────────────────────────────────────────

/**
 * Parse the failing line number from a `python3 -c "compile(...)"` traceback.
 *
 * The traceback always has at least two `File "...", line N` entries: the first
 * is `File "<string>", line 1, in <module>` (an artifact of the `-c` wrapper —
 * always line 1, never the real error location), and the real failing line is on
 * a later `File` entry. Taking the LAST match (rather than the first) avoids
 * misreporting every syntax error as line 1.
 *
 * @param stderr - Combined stderr output from the `python3 -c` invocation
 * @returns The line number of the real syntax error, or null if none found
 */
function parsePythonLineNumber(stderr: string): number | null {
  const matches = [...stderr.matchAll(/File "[^"]*", line (\d+)/g)];
  if (matches.length === 0) return null;
  return parseInt(matches[matches.length - 1][1], 10);
}

/**
 * Run `python3 -c "compile(open(f).read(), f, 'exec')"` to validate Python syntax.
 *
 * `compile()` performs a full parse without executing the module, so it catches
 * syntax errors (unclosed brackets, bad indentation, invalid statements) without
 * running arbitrary code from the instrumented file.
 *
 * @param filePath - Absolute path to the Python file to check
 * @returns CheckResult with ruleId 'NDS-001', tier 1, blocking true
 */
export function checkSyntax(filePath: string): CheckResult {
  try {
    execFileSync(
      'python3',
      ['-c', `compile(open(${JSON.stringify(filePath)}).read(), ${JSON.stringify(filePath)}, 'exec')`],
      { timeout: 10_000, stdio: ['pipe', 'pipe', 'pipe'] },
    );

    return {
      ruleId: 'NDS-001',
      passed: true,
      filePath,
      lineNumber: null,
      message: "Syntax check passed (python3 compile() exit code 0).",
      tier: 1,
      blocking: true,
    };
  } catch (error: unknown) {
    const isErrorObj = error !== null && typeof error === 'object';
    const stderr = isErrorObj && 'stderr' in error && error.stderr instanceof Buffer
      ? error.stderr.toString()
      : error instanceof Error
        ? error.message
        : String(error);

    const lineNumber = parsePythonLineNumber(stderr);

    return {
      ruleId: 'NDS-001',
      passed: false,
      filePath,
      lineNumber,
      message:
        `NDS-001 check failed: python3 compile() returned a non-zero exit code. ${stderr.trim()} ` +
        `Fix the Python syntax error${lineNumber ? ` at line ${lineNumber}` : ''} and ensure the file is valid Python.`,
      tier: 1,
      blocking: true,
    };
  }
}

// ─── formatting (Ruff-first, Black-fallback per OD-2) ─────────────────────────

/**
 * The canonical "no formatter installed" message, per OD-2's exact wording.
 * Kept as a single constant so formatCode's silent fallback and lintCheck's
 * failure message can never drift from each other or from the PRD's spec.
 */
const NO_FORMATTER_MESSAGE = 'Python formatter not found. Install ruff (pip install ruff) or black (pip install black).';

interface FormatAttempt {
  /** The formatted code, or the original source if the tool wasn't found or failed. */
  code: string;
  /** True once any formatter binary (ruff or black) was found on PATH, regardless of whether it accepted the input. */
  formatterAvailable: boolean;
}

/**
 * Try a single formatter binary in stdin→stdout mode.
 *
 * @returns The formatted stdout on success, or null if the binary is missing
 *   (`ENOENT`) or the invocation failed for any other reason (e.g. the binary
 *   is installed but rejected the input — a real parse error, not a "not
 *   installed" case).
 */
function tryFormatterBinary(binary: string, args: string[], source: string, configDir: string): { output: string | null; found: boolean } {
  try {
    const output = execFileSync(binary, args, {
      input: source,
      cwd: configDir,
      timeout: 10_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).toString();
    return { output, found: true };
  } catch (error: unknown) {
    const isEnoent = error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
    return { output: null, found: !isEnoent };
  }
}

/**
 * Run Ruff first, then Black, against the given source. Config (pyproject.toml,
 * ruff.toml, etc.) is resolved from `configDir` via the subprocess's `cwd` — Ruff
 * and Black both walk up from the working directory when formatting stdin.
 *
 * @param source - Source code to format
 * @param configDir - Directory to resolve formatter config from
 */
function runFormatter(source: string, configDir: string): FormatAttempt {
  const stdinFilename = join(configDir, '_spiny_orb_format_target.py');

  const ruff = tryFormatterBinary('ruff', ['format', '--stdin-filename', stdinFilename, '-'], source, configDir);
  if (ruff.output !== null) return { code: ruff.output, formatterAvailable: true };
  if (ruff.found) return { code: source, formatterAvailable: true };

  const black = tryFormatterBinary('black', ['--stdin-filename', stdinFilename, '-q', '-'], source, configDir);
  if (black.output !== null) return { code: black.output, formatterAvailable: true };
  if (black.found) return { code: source, formatterAvailable: true };

  return { code: source, formatterAvailable: false };
}

/**
 * Format Python source using Ruff (preferred) or Black (fallback), per OD-2.
 *
 * Always resolves to a string: the formatted source, or the original source
 * unchanged if neither formatter is installed or formatting otherwise fails.
 * `lintCheck()` is the surface that reports a missing-formatter failure.
 *
 * @param source - Source code text to format
 * @param configDir - Directory to search for formatter config files
 * @returns Formatted source, or original source if no formatter succeeded
 */
export function formatCode(source: string, configDir: string): Promise<string> {
  return Promise.resolve(runFormatter(source, configDir).code);
}

/**
 * Run diff-based lint checking on original and instrumented Python code.
 *
 * A file is "compliant" when running it through the formatter produces no
 * change (idempotent under Ruff/Black) — the same signal Ruff's own `--check`
 * and Black's own `--check` use internally. Decision matrix matches the
 * JavaScript/TypeScript providers: only a *newly introduced* violation fails.
 *
 * When neither Ruff nor Black is installed, fails with OD-2's canonical
 * message rather than silently passing everything (the pipeline would
 * otherwise never know formatting was never actually checked).
 *
 * @param original - Original source code before instrumentation
 * @param instrumented - Instrumented source code to check
 * @returns CheckResult with ruleId 'LINT', tier 1, blocking true
 */
export async function lintCheck(original: string, instrumented: string): Promise<CheckResult> {
  const filePath = 'file.py';

  // No real on-disk config directory is available from this interface (the
  // LanguageProvider contract doesn't pass one to lintCheck); use the process
  // working directory so project-level pyproject.toml/ruff.toml still resolve
  // for the common case of running spiny-orb from the project root.
  const configDir = process.cwd();

  const originalAttempt = runFormatter(original, configDir);
  if (!originalAttempt.formatterAvailable) {
    return {
      ruleId: 'LINT',
      passed: false,
      filePath,
      lineNumber: null,
      message: `LINT check failed: ${NO_FORMATTER_MESSAGE}`,
      tier: 1,
      blocking: true,
    };
  }

  const instrumentedAttempt = runFormatter(instrumented, configDir);
  const originalCompliant = originalAttempt.code === original;
  const outputCompliant = instrumentedAttempt.code === instrumented;

  if (originalCompliant && !outputCompliant) {
    return {
      ruleId: 'LINT',
      passed: false,
      filePath,
      lineNumber: null,
      message:
        `LINT check failed: the original file was formatter-compliant but the instrumented output is not. ` +
        `The agent introduced formatting violations. ` +
        `Run Ruff or Black on the output to match the project's formatting configuration.`,
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
      ? 'Lint check passed: output matches formatter configuration.'
      : outputCompliant
        ? 'Lint check passed: output is formatter-compliant and improves on a non-compliant original.'
        : 'Lint check passed: original was not formatter-compliant, so non-compliance in output is not a new error.',
    tier: 1,
    blocking: true,
  };
}

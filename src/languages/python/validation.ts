// ABOUTME: Python-specific Tier 1 validation: syntax checking (python3 compile()) and formatter checking (Ruff/Black).
// ABOUTME: Mirrors javascript/validation.ts and typescript/validation.ts, but formats via Ruff-first/Black-fallback per OD-2.

import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
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
 * Whether a `compile()` traceback is actually a syntax error, as opposed to
 * some other failure (a crash, an out-of-memory condition, an unrelated
 * exception raised while opening the file). Only the SyntaxError family
 * gets "fix the syntax error at line N" framing and a parsed line number —
 * anything else is a generic tool failure with no such claim.
 */
function isPythonSyntaxErrorTraceback(stderr: string): boolean {
  return /\b(SyntaxError|IndentationError|TabError)\b/.test(stderr);
}

/**
 * Run `python3 -c "import tokenize; compile(tokenize.open(f).read(), f, 'exec')"` to validate Python syntax.
 *
 * `compile()` performs a full parse without executing the module, so it catches
 * syntax errors (unclosed brackets, bad indentation, invalid statements) without
 * running arbitrary code from the instrumented file. `tokenize.open()` (not plain
 * `open()`) honors a file's own PEP 263 encoding declaration.
 *
 * @param filePath - Absolute path to the Python file to check
 * @returns CheckResult with ruleId 'NDS-001', tier 1, blocking true
 */
export function checkSyntax(filePath: string): CheckResult {
  try {
    execFileSync(
      'python3',
      [
        '-c',
        // tokenize.open() (not plain open()) honors a PEP 263 encoding declaration
        // (e.g. `# -*- coding: latin-1 -*-`) — plain open() decodes using the
        // locale's default encoding and can misdecode or raise UnicodeDecodeError
        // on a file whose declared encoding differs from that default.
        `import tokenize; compile(tokenize.open(${JSON.stringify(filePath)}).read(), ${JSON.stringify(filePath)}, 'exec')`,
      ],
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

    if (isErrorObj && 'code' in error && error.code === 'ENOENT') {
      return {
        ruleId: 'NDS-001',
        passed: false,
        filePath,
        lineNumber: null,
        message: 'NDS-001 check failed: python3 was not found on PATH. Install Python 3 to run the syntax check.',
        tier: 1,
        blocking: true,
      };
    }

    const stderr = isErrorObj && 'stderr' in error && error.stderr instanceof Buffer
      ? error.stderr.toString()
      : error instanceof Error
        ? error.message
        : String(error);

    if (!isPythonSyntaxErrorTraceback(stderr)) {
      return {
        ruleId: 'NDS-001',
        passed: false,
        filePath,
        lineNumber: null,
        message: `NDS-001 check failed: could not complete the syntax check. ${stderr.trim()}`,
        tier: 1,
        blocking: true,
      };
    }

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
  /**
   * True when a formatter binary was found but rejected the input — could be
   * a real parse error in the source, or an unrelated execution/configuration
   * problem (e.g. a malformed `pyproject.toml`). `code` still equals the
   * input source in this case, but that equality does NOT mean "the
   * formatter found no changes needed" — the formatter never actually ran to
   * completion. Callers must not treat this as "compliant."
   */
  executionFailed: boolean;
  /** Trimmed stderr from the failing invocation, when `executionFailed` is true. Empty otherwise. */
  executionError: string;
}

/**
 * Try a single formatter binary in stdin→stdout mode.
 *
 * @returns The formatted stdout on success, or null if the binary is missing
 *   (`ENOENT`) or the invocation failed for any other reason (e.g. the binary
 *   is installed but rejected the input — a real parse error, not a "not
 *   installed" case). `error` carries the trimmed stderr for a non-ENOENT
 *   failure, so callers can surface *why* the formatter rejected the input
 *   rather than assuming it was necessarily a parse error.
 */
function tryFormatterBinary(binary: string, args: string[], source: string, configDir: string): { output: string | null; found: boolean; error: string } {
  try {
    const output = execFileSync(binary, args, {
      input: source,
      cwd: configDir,
      timeout: 10_000,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Node's execFileSync default maxBuffer is 1 MiB — a large source file's
      // formatted output could exceed that and throw ENOBUFS/"maxBuffer exceeded"
      // instead of returning the formatted code.
      maxBuffer: 64 * 1024 * 1024,
    }).toString();
    return { output, found: true, error: '' };
  } catch (error: unknown) {
    const isErrorObj = error !== null && typeof error === 'object';
    const isEnoent = isErrorObj && 'code' in error && error.code === 'ENOENT';
    const stderr = isErrorObj && 'stderr' in error && error.stderr instanceof Buffer
      ? error.stderr.toString().trim()
      : error instanceof Error
        ? error.message
        : String(error);
    return { output: null, found: !isEnoent, error: isEnoent ? '' : stderr };
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

  // A Ruff execution failure (installed but rejects this specific input) falls
  // through to Black rather than returning immediately — Black may still
  // successfully format input Ruff can't handle. Only report a failure once
  // both formatters have had a chance to run.
  const ruff = tryFormatterBinary('ruff', ['format', '--stdin-filename', stdinFilename, '-'], source, configDir);
  if (ruff.output !== null) return { code: ruff.output, formatterAvailable: true, executionFailed: false, executionError: '' };

  const black = tryFormatterBinary('black', ['--stdin-filename', stdinFilename, '-q', '-'], source, configDir);
  if (black.output !== null) return { code: black.output, formatterAvailable: true, executionFailed: false, executionError: '' };

  if (black.found) return { code: source, formatterAvailable: true, executionFailed: true, executionError: black.error };
  if (ruff.found) return { code: source, formatterAvailable: true, executionFailed: true, executionError: ruff.error };

  return { code: source, formatterAvailable: false, executionFailed: false, executionError: '' };
}

/**
 * Whether a formatted-source attempt counts as "compliant" with the formatter.
 *
 * An execution failure (the formatter rejected the input) is never compliant,
 * even though `attempt.code` equals the input in that case — that equality
 * means "the formatter never produced a real answer," not "no changes needed."
 */
function isCompliant(attempt: FormatAttempt, sourceText: string): boolean {
  if (attempt.executionFailed) return false;
  return attempt.code === sourceText;
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
 * @param filePath - The file's real on-disk path; Ruff/Black config is resolved
 *   from its directory (matches `formatCode()`'s own `configDir` parameter)
 * @returns CheckResult with ruleId 'LINT', tier 1, blocking true
 */
export async function lintCheck(original: string, instrumented: string, filePath: string): Promise<CheckResult> {
  const projectDir = dirname(filePath);

  const originalAttempt = runFormatter(original, projectDir);
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

  const instrumentedAttempt = runFormatter(instrumented, projectDir);

  // A formatter execution failure on the instrumented output (a real parse
  // failure — a parse error, or an unrelated execution/config problem — is
  // reported on its own — regardless of whether the original was itself
  // compliant. Folding this into the ordinary compliance matrix would let
  // it fall through to the "original was already non-compliant, so this
  // isn't a new error" pass branch whenever the original also happened to
  // be non-compliant, which mischaracterizes a real failure as an
  // unremarkable style issue.
  if (instrumentedAttempt.executionFailed) {
    return {
      ruleId: 'LINT',
      passed: false,
      filePath,
      lineNumber: null,
      message:
        `LINT check failed: the formatter could not process the instrumented output. ` +
        `${instrumentedAttempt.executionError} ` +
        `This may be a parse error in the agent's output, or an unrelated formatter/configuration problem — ` +
        `run Ruff or Black directly on the output to see the underlying error.`,
      tier: 1,
      blocking: true,
    };
  }

  const originalCompliant = isCompliant(originalAttempt, original);
  const outputCompliant = isCompliant(instrumentedAttempt, instrumented);

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

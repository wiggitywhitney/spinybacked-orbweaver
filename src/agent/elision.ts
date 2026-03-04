// ABOUTME: Basic elision rejection — detects truncated or lazy LLM output before validation.
// ABOUTME: Pattern scan for placeholder comments + length comparison against original source.

/**
 * Result of elision detection on LLM output.
 * Provides structured diagnostics for the caller.
 */
export interface ElisionResult {
  /** Whether elision was detected (patterns found or output too short). */
  elisionDetected: boolean;
  /** Specific placeholder patterns found in the output. */
  patternsFound: string[];
  /** Ratio of output lines to input lines (>1.0 means output grew). */
  lengthRatio: number;
  /** Human-readable explanation of what was detected, empty if clean. */
  reason: string;
}

/**
 * Elision patterns to scan for in LLM output.
 * Each pattern is a regex that matches common placeholder comments
 * used by LLMs when they truncate code.
 */
const ELISION_PATTERNS: Array<{ regex: RegExp; label: string }> = [
  { regex: /^\s*\/\/\s*\.{3}\s*$/m, label: '// ...' },
  { regex: /\/\*\s*\.{3}\s*\*\//m, label: '/* ... */' },
  { regex: /^\s*\/\/\s*existing code/im, label: '// existing code' },
  { regex: /^\s*\/\/\s*rest of/im, label: '// rest of' },
  { regex: /^\s*\/\/\s*remaining code/im, label: '// remaining code' },
  { regex: /^\s*\/\/\s*TODO:\s*original code/im, label: '// TODO: original code' },
];

/**
 * Minimum ratio of output lines to input lines.
 * Below this threshold, the output is flagged as potentially truncated.
 * The threshold is intentionally conservative — real elision is dramatic.
 */
const LENGTH_RATIO_THRESHOLD = 0.8;

/**
 * Detect elision (truncation or lazy placeholder comments) in LLM output.
 *
 * This is a pre-validation sanity check, not part of the formal validation chain.
 * It catches the most common full-file output failure mode cheaply
 * (string matching, no AST needed).
 *
 * @param output - The LLM's generated code (instrumentedCode field)
 * @param original - The original source code before instrumentation
 * @returns Structured result indicating whether elision was detected
 */
export function detectElision(output: string, original: string): ElisionResult {
  const patternsFound: string[] = [];
  const reasons: string[] = [];

  // Pattern scan
  for (const { regex, label } of ELISION_PATTERNS) {
    if (regex.test(output)) {
      patternsFound.push(label);
    }
  }

  if (patternsFound.length > 0) {
    reasons.push(`Placeholder patterns detected: ${patternsFound.join(', ')}`);
  }

  // Length comparison — empty string is 0 lines (not 1)
  const outputLines = output === '' ? 0 : output.split('\n').length;
  const originalLines = original === '' ? 0 : original.split('\n').length;
  const lengthRatio = originalLines > 0 ? outputLines / originalLines : 1;

  if (lengthRatio < LENGTH_RATIO_THRESHOLD) {
    reasons.push(
      `Output is ${Math.round(lengthRatio * 100)}% of input length ` +
        `(${outputLines} vs ${originalLines} lines, threshold: ${LENGTH_RATIO_THRESHOLD * 100}%)`,
    );
  }

  const elisionDetected = patternsFound.length > 0 || lengthRatio < LENGTH_RATIO_THRESHOLD;

  return {
    elisionDetected,
    patternsFound,
    lengthRatio,
    reason: reasons.join('. '),
  };
}

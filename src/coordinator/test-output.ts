// ABOUTME: Helpers for surfacing test subprocess output in CLI failure messages.
// ABOUTME: Handles inline display (short output) and line-boundary truncation (long output).

const DEFAULT_MAX_LINES = 50;

/**
 * Format test subprocess output for inclusion in a CLI failure message.
 *
 * For short output (≤ maxLines), returns the full output as `display`.
 * For long output (> maxLines), truncates at a line boundary and appends a
 * `... N more lines ...` marker so the user knows there is more to read.
 *
 * @param output - Raw stdout/stderr from the test subprocess
 * @param maxLines - Maximum lines before truncation (default: 50)
 */
export function formatTestOutput(
  output: string,
  maxLines = DEFAULT_MAX_LINES,
): { display: string; truncated: boolean; totalLines: number } {
  const lines = output.split('\n');
  const totalLines = lines.length;

  if (totalLines <= maxLines) {
    return { display: output, truncated: false, totalLines };
  }

  const kept = lines.slice(0, maxLines).join('\n');
  const remaining = totalLines - maxLines;
  const display = `${kept}\n... ${remaining} more line${remaining === 1 ? '' : 's'} (see full output in log file)`;
  return { display, truncated: true, totalLines };
}

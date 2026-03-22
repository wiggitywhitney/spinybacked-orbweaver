// ABOUTME: Computes the companion .instrumentation.md file path from an instrumented file path.
// ABOUTME: Shared by CLI output, MCP tool, and git workflow to avoid duplicating path logic.

import { extname } from 'node:path';

/**
 * Compute the companion file path for an instrumented file.
 * Replaces the file extension with `.instrumentation.md`.
 *
 * @param filePath - Path to the instrumented file (absolute or relative)
 * @returns Path to the companion reasoning report
 */
export function companionPath(filePath: string): string {
  const ext = extname(filePath);
  const basePath = ext && ext !== '.'
    ? filePath.slice(0, -ext.length)
    : filePath.replace(/\.$/, '');
  return `${basePath}.instrumentation.md`;
}

// ABOUTME: Generates per-file markdown reasoning reports from FileResult data.
// ABOUTME: Explains what spans were added, what was skipped, validation journey, and cost.

import { basename, relative } from 'node:path';
import type { FileResult } from '../fix-loop/types.ts';
import { formatRuleId } from '../validation/rule-names.ts';

/**
 * Render a markdown reasoning report for an instrumented file.
 * Consumes the FileResult produced by instrumentWithRetry and generates
 * a human-readable explanation of what happened and why.
 *
 * @param result - Complete FileResult from the fix loop
 * @param projectDir - Optional project root used to compute a relative path for the report title.
 *   When provided, the title shows the path relative to this directory.
 *   When omitted, falls back to the basename of the file path.
 * @returns Markdown string suitable for writing to a companion .md file
 */
export function renderReasoningReport(result: FileResult, projectDir?: string): string {
  const sections: string[] = [];

  const displayPath = projectDir ? relative(projectDir, result.path) : basename(result.path);
  sections.push(`# Instrumentation Report: ${displayPath}`);
  sections.push('');

  // Summary section
  sections.push('## Summary');
  sections.push(`- **Status**: ${result.status}`);
  sections.push(`- **Spans added**: ${result.spansAdded}`);
  sections.push(`- **Attempts**: ${result.validationAttempts} (${result.validationStrategyUsed})`);
  sections.push(`- **Input tokens**: ${(result.tokenUsage.inputTokens / 1000).toFixed(1)}K`);
  sections.push(`- **Output tokens**: ${(result.tokenUsage.outputTokens / 1000).toFixed(1)}K`);
  if (result.tokenUsage.cacheReadInputTokens > 0) {
    sections.push(`- **Cached tokens**: ${(result.tokenUsage.cacheReadInputTokens / 1000).toFixed(1)}K`);
  }
  sections.push('');

  // Schema extensions
  if (result.schemaExtensions.length > 0) {
    sections.push('## Schema Extensions');
    for (const ext of result.schemaExtensions) {
      sections.push(`- \`${ext}\``);
    }
    sections.push('');
  }

  // Function-level details (when function-level fallback was used)
  if (result.functionResults && result.functionResults.length > 0) {
    sections.push('## Function-Level Results');
    sections.push('');
    sections.push('| Function | Status | Spans |');
    sections.push('|----------|--------|-------|');
    for (const fn of result.functionResults) {
      const esc = (s: string) => s.replace(/\|/g, '\\|');
      const status = fn.success ? 'instrumented' : 'skipped';
      const reason = fn.success ? '' : (fn.error ? ` — ${esc(fn.error)}` : '');
      sections.push(`| ${esc(fn.name)} | ${status}${reason} | ${fn.spansAdded} |`);
    }
    sections.push('');
  }

  // Validation journey
  if (result.errorProgression && result.errorProgression.length > 0) {
    sections.push('## Validation Journey');
    for (let i = 0; i < result.errorProgression.length; i++) {
      sections.push(`${i + 1}. **Attempt ${i + 1}**: ${result.errorProgression[i]}`);
    }
    sections.push('');
  }

  // Agent notes
  if (result.notes && result.notes.length > 0) {
    sections.push('## Notes');
    for (const note of result.notes) {
      sections.push(`- ${note}`);
    }
    sections.push('');
  }

  // Advisory annotations
  if (result.advisoryAnnotations && result.advisoryAnnotations.length > 0) {
    sections.push('## Advisory Findings');
    for (const finding of result.advisoryAnnotations) {
      const location = finding.lineNumber ? `:${finding.lineNumber}` : '';
      sections.push(`- ${formatRuleId(finding.ruleId)}${location}: ${finding.message}`);
    }
    sections.push('');
  }

  // Failure details
  if (result.status === 'failed' && result.reason) {
    sections.push('## Failure Details');
    sections.push(result.reason);
    sections.push('');
  }

  return sections.join('\n');
}

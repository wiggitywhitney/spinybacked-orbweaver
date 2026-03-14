// ABOUTME: Renders RunResult into a complete PR description in markdown.
// ABOUTME: Produces all spec-required sections: per-file status, span categories, schema diff, review sensitivity, notes, token usage, version.

import type { RunResult } from '../coordinator/types.ts';
import type { FileResult } from '../fix-loop/types.ts';
import type { AgentConfig } from '../config/schema.ts';
import type { CheckResult } from '../validation/types.ts';
import { tokensToDollars, ceilingToDollars, formatDollars } from './cost-formatting.ts';
import { writeFile } from 'node:fs/promises';
import { relative, basename, join } from 'node:path';

/** A function that converts a file path to a display string. */
type DisplayFn = (filePath: string) => string;

/**
 * Render a complete PR description from a RunResult and agent config.
 *
 * @param runResult - Aggregate result from the coordinator
 * @param config - Agent configuration (used for model, reviewSensitivity)
 * @param projectDir - Absolute path to the project root, used to compute repo-relative paths.
 *   When provided, file paths display as repo-relative (e.g., "src/api/index.ts").
 *   When omitted, falls back to basename only.
 * @returns Markdown string for the PR body
 */
export function renderPrSummary(runResult: RunResult, config: AgentConfig, projectDir?: string): string {
  const display: DisplayFn = (filePath: string) => displayPath(filePath, projectDir);
  const sections: string[] = [];

  sections.push(renderSummaryHeader(runResult, config));
  sections.push(renderPerFileStatus(runResult, display));
  sections.push(renderSpanCategoryBreakdown(runResult, display));
  sections.push(renderSchemaChanges(runResult));
  sections.push(renderReviewSensitivity(runResult, config, display));
  sections.push(renderAgentNotes(runResult, display));
  sections.push(renderTokenUsage(runResult, config));
  sections.push(renderLiveCheckCompliance(runResult));
  sections.push(renderAgentVersion(runResult));
  sections.push(renderWarnings(runResult));

  return sections.filter(Boolean).join('\n\n');
}

/**
 * Format a number with commas for readability.
 *
 * @param n - Number to format
 * @returns Formatted string (e.g., "40,000")
 */
function formatNumber(n: number): string {
  return n.toLocaleString('en-US');
}

/**
 * Convert a file path to a display-friendly string.
 *
 * When projectDir is provided, returns the repo-relative path (e.g., "src/api/index.ts").
 * Otherwise falls back to basename only.
 *
 * @param filePath - Absolute or relative file path
 * @param projectDir - Optional project root for computing relative paths
 * @returns Display-friendly path string
 */
function displayPath(filePath: string, projectDir?: string): string {
  if (projectDir) {
    const rel = relative(projectDir, filePath);
    // If relative path escapes the project root, fall back to basename
    if (!rel.startsWith('..') && !rel.startsWith('/')) {
      return rel;
    }
  }
  return basename(filePath);
}

function renderSummaryHeader(runResult: RunResult, config: AgentConfig): string {
  const lines: string[] = ['## Summary'];
  lines.push('');
  lines.push(`- **Files processed**: ${runResult.filesProcessed}`);
  lines.push(`- **Succeeded**: ${runResult.filesSucceeded}`);
  if (runResult.filesFailed > 0) {
    lines.push(`- **Failed**: ${runResult.filesFailed}`);
  }
  if (runResult.filesSkipped > 0) {
    lines.push(`- **Skipped**: ${runResult.filesSkipped}`);
  }
  if (runResult.sdkInitUpdated) {
    lines.push(`- **SDK init**: updated`);
  }
  if (runResult.librariesInstalled.length > 0) {
    lines.push(`- **Libraries installed**: ${runResult.librariesInstalled.join(', ')}`);
  }
  if (runResult.libraryInstallFailures.length > 0) {
    lines.push(`- **Library install failures**: ${runResult.libraryInstallFailures.join(', ')}`);
  }
  return lines.join('\n');
}

function renderPerFileStatus(runResult: RunResult, display: DisplayFn): string {
  const lines: string[] = ['## Per-File Results'];
  lines.push('');
  lines.push('| File | Status | Spans | Libraries | Schema Extensions |');
  lines.push('|------|--------|-------|-----------|-------------------|');

  for (const file of runResult.fileResults) {
    const name = display(file.path);
    let statusText = file.status === 'success' ? 'success' : file.status === 'failed' ? 'failed' : 'skipped';
    if (file.status === 'failed' && file.reason) {
      statusText = `failed: ${sanitizeCell(file.reason)}`;
    }
    const libs = file.librariesNeeded.map(l => `\`${l.package}\``).join(', ') || '—';
    const exts = file.schemaExtensions.length > 0
      ? file.schemaExtensions.map(e => `\`${sanitizeCell(e)}\``).join(', ')
      : '—';

    lines.push(`| ${name} | ${statusText} | ${file.spansAdded} | ${libs} | ${exts} |`);
  }

  return lines.join('\n');
}

/**
 * Sanitize a string for use inside a markdown table cell.
 * Collapses newlines and escapes pipe characters.
 */
function sanitizeCell(value: string): string {
  return value.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
}

function renderSpanCategoryBreakdown(runResult: RunResult, display: DisplayFn): string {
  const filesWithCategories = runResult.fileResults.filter(
    (f): f is FileResult & { spanCategories: NonNullable<FileResult['spanCategories']> } =>
      f.spanCategories != null,
  );

  if (filesWithCategories.length === 0) return '';

  const lines: string[] = ['## Span Category Breakdown'];
  lines.push('');
  lines.push('| File | External Calls | Schema-Defined | Service Entry Points | Total Functions |');
  lines.push('|------|---------------|----------------|---------------------|-----------------|');

  for (const file of filesWithCategories) {
    const name = display(file.path);
    const cats = file.spanCategories;
    lines.push(
      `| ${name} | ${cats.externalCalls} | ${cats.schemaDefined} | ${cats.serviceEntryPoints} | ${cats.totalFunctionsInFile} |`,
    );
  }

  return lines.join('\n');
}

function renderSchemaChanges(runResult: RunResult): string {
  const lines: string[] = ['## Schema Changes'];
  lines.push('');

  if (runResult.schemaDiff) {
    lines.push(runResult.schemaDiff);
  } else {
    lines.push('No schema changes detected.');
  }

  return lines.join('\n');
}

function renderReviewSensitivity(runResult: RunResult, config: AgentConfig, display: DisplayFn): string {
  const lines: string[] = [];

  // Collect advisory annotations from all files
  const allAdvisory: Array<{ file: string; annotation: CheckResult }> = [];
  for (const file of runResult.fileResults) {
    if (file.advisoryAnnotations) {
      for (const ann of file.advisoryAnnotations) {
        allAdvisory.push({ file: display(file.path), annotation: ann });
      }
    }
  }

  // Run-level advisory findings
  if (runResult.runLevelAdvisory.length > 0) {
    for (const ann of runResult.runLevelAdvisory) {
      allAdvisory.push({ file: '(run-level)', annotation: ann });
    }
  }

  // Review sensitivity warnings
  if (config.reviewSensitivity !== 'off') {
    const sensitivityWarnings = computeSensitivityWarnings(runResult, config, display);
    if (sensitivityWarnings.length > 0) {
      lines.push('## Review Attention');
      lines.push('');
      for (const warning of sensitivityWarnings) {
        lines.push(`- ${warning}`);
      }
    }
  }

  // Advisory annotations section
  if (allAdvisory.length > 0) {
    if (lines.length === 0) {
      lines.push('## Review Attention');
      lines.push('');
    } else {
      lines.push('');
    }
    lines.push('### Advisory Findings');
    lines.push('');
    for (const { file, annotation } of allAdvisory) {
      const loc = annotation.lineNumber ? `:${annotation.lineNumber}` : '';
      lines.push(`- **${annotation.ruleId}** (${file}${loc}): ${annotation.message}`);
    }
  }

  return lines.join('\n');
}

/**
 * Compute review sensitivity warnings based on config level.
 *
 * @param runResult - Run results with per-file span categories
 * @param config - Agent config with reviewSensitivity setting
 * @returns Array of warning strings
 */
function computeSensitivityWarnings(runResult: RunResult, config: AgentConfig, display: DisplayFn): string[] {
  const warnings: string[] = [];
  const filesWithCategories = runResult.fileResults.filter(
    (f): f is FileResult & { spanCategories: NonNullable<FileResult['spanCategories']> } =>
      f.spanCategories != null,
  );

  if (filesWithCategories.length === 0) return warnings;

  if (config.reviewSensitivity === 'strict') {
    // Flag any file with tier 3+ spans (service entry points)
    for (const file of filesWithCategories) {
      if (file.spanCategories.serviceEntryPoints > 0) {
        warnings.push(
          `**${display(file.path)}**: ${file.spanCategories.serviceEntryPoints} service entry point span(s) — review recommended (tier 3)`,
        );
      }
    }
  } else if (config.reviewSensitivity === 'moderate') {
    // Flag statistical outliers: files significantly above average span count
    const spanCounts = filesWithCategories.map(f => f.spansAdded);
    const mean = spanCounts.reduce((a, b) => a + b, 0) / spanCounts.length;
    const threshold = mean * 2; // Files with >2x average spans

    if (mean > 0) {
      for (const file of filesWithCategories) {
        if (file.spansAdded > threshold) {
          warnings.push(
            `**${display(file.path)}**: ${file.spansAdded} spans added (average: ${Math.round(mean)}) — outlier, review recommended`,
          );
        }
      }
    }
  }

  return warnings;
}

function renderAgentNotes(runResult: RunResult, display: DisplayFn): string {
  const filesWithNotes = runResult.fileResults.filter(
    f => f.notes && f.notes.length > 0,
  );

  if (filesWithNotes.length === 0) return '';

  const lines: string[] = ['## Agent Notes'];
  lines.push('');

  for (const file of filesWithNotes) {
    lines.push(`**${display(file.path)}**:`);
    for (const note of file.notes!) {
      lines.push(`- ${note}`);
    }
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

function renderTokenUsage(runResult: RunResult, config: AgentConfig): string {
  const lines: string[] = ['## Token Usage'];
  lines.push('');

  let costRow: string;
  try {
    const ceilingDollars = ceilingToDollars(runResult.costCeiling, config.agentModel);
    const actualDollars = tokensToDollars(runResult.actualTokenUsage, config.agentModel);
    costRow = `| **Cost** | ${formatDollars(ceilingDollars)} | ${formatDollars(actualDollars)} |`;
  } catch {
    costRow = `| **Cost** | unknown | unknown |`;
  }

  lines.push('| | Ceiling | Actual |');
  lines.push('|---|---------|--------|');
  lines.push(costRow);
  lines.push(`| **Input tokens** | ${formatNumber(runResult.costCeiling.maxTokensCeiling)} | ${formatNumber(runResult.actualTokenUsage.inputTokens)} |`);
  lines.push(`| **Output tokens** | — | ${formatNumber(runResult.actualTokenUsage.outputTokens)} |`);

  if (runResult.actualTokenUsage.cacheReadInputTokens > 0) {
    lines.push(`| **Cache read tokens** | — | ${formatNumber(runResult.actualTokenUsage.cacheReadInputTokens)} |`);
  }
  if (runResult.actualTokenUsage.cacheCreationInputTokens > 0) {
    lines.push(`| **Cache write tokens** | — | ${formatNumber(runResult.actualTokenUsage.cacheCreationInputTokens)} |`);
  }

  lines.push('');
  lines.push(`Model: \`${config.agentModel}\` | Files: ${runResult.costCeiling.fileCount} | Total file size: ${formatNumber(runResult.costCeiling.totalFileSizeBytes)} bytes`);

  return lines.join('\n');
}

function renderAgentVersion(runResult: RunResult): string {
  const version = runResult.fileResults.find(f => f.agentVersion)?.agentVersion;
  if (!version) return '';

  return `## Agent Version\n\n\`${version}\``;
}

function renderLiveCheckCompliance(runResult: RunResult): string {
  if (!runResult.endOfRunValidation) return '';

  const lines: string[] = ['## Live-Check Compliance'];
  lines.push('');
  lines.push(runResult.endOfRunValidation);

  return lines.join('\n');
}

function renderWarnings(runResult: RunResult): string {
  if (runResult.warnings.length === 0) return '';

  const lines: string[] = ['## Warnings'];
  lines.push('');
  for (const warning of runResult.warnings) {
    lines.push(`- ${warning}`);
  }

  return lines.join('\n');
}

/**
 * Write the rendered PR summary to a local file.
 * Persists the summary so it survives push or PR creation failures.
 *
 * @param projectDir - Project root directory
 * @param content - Rendered PR summary markdown
 * @returns Absolute path to the written file
 */
export async function writePrSummary(projectDir: string, content: string): Promise<string> {
  const filePath = join(projectDir, 'orbweaver-pr-summary.md');
  await writeFile(filePath, content, 'utf-8');
  return filePath;
}

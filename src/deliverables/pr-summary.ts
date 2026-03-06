// ABOUTME: Renders RunResult into a complete PR description in markdown.
// ABOUTME: Produces all spec-required sections: per-file status, span categories, schema diff, review sensitivity, notes, token usage, version.

import type { RunResult } from '../coordinator/types.ts';
import type { FileResult } from '../fix-loop/types.ts';
import type { AgentConfig } from '../config/schema.ts';
import type { CheckResult } from '../validation/types.ts';
import { tokensToDollars, ceilingToDollars, formatDollars } from './cost-formatting.ts';
import { basename } from 'node:path';

/**
 * Render a complete PR description from a RunResult and agent config.
 *
 * @param runResult - Aggregate result from the coordinator
 * @param config - Agent configuration (used for model, reviewSensitivity)
 * @returns Markdown string for the PR body
 */
export function renderPrSummary(runResult: RunResult, config: AgentConfig): string {
  const sections: string[] = [];

  sections.push(renderSummaryHeader(runResult, config));
  sections.push(renderPerFileStatus(runResult));
  sections.push(renderSpanCategoryBreakdown(runResult));
  sections.push(renderSchemaChanges(runResult));
  sections.push(renderReviewSensitivity(runResult, config));
  sections.push(renderAgentNotes(runResult));
  sections.push(renderTokenUsage(runResult, config));
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
 * Extract just the filename from a path for display.
 *
 * @param filePath - Absolute or relative file path
 * @returns Filename only (e.g., "api-client.js")
 */
function displayPath(filePath: string): string {
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

function renderPerFileStatus(runResult: RunResult): string {
  const lines: string[] = ['## Per-File Results'];
  lines.push('');
  lines.push('| File | Status | Spans | Libraries | Schema Extensions |');
  lines.push('|------|--------|-------|-----------|-------------------|');

  for (const file of runResult.fileResults) {
    const name = displayPath(file.path);
    const statusIcon = file.status === 'success' ? 'success' : file.status === 'failed' ? 'failed' : 'skipped';
    const libs = file.librariesNeeded.map(l => `\`${l.package}\``).join(', ') || '—';
    const exts = file.schemaExtensions.length > 0
      ? file.schemaExtensions.map(e => `\`${e}\``).join(', ')
      : '—';

    lines.push(`| ${name} | ${statusIcon} | ${file.spansAdded} | ${libs} | ${exts} |`);

    if (file.status === 'failed' && file.reason) {
      lines.push(`| | | | \\> ${file.reason} | |`);
    }
  }

  return lines.join('\n');
}

function renderSpanCategoryBreakdown(runResult: RunResult): string {
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
    const name = displayPath(file.path);
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

function renderReviewSensitivity(runResult: RunResult, config: AgentConfig): string {
  const lines: string[] = [];

  // Collect advisory annotations from all files
  const allAdvisory: Array<{ file: string; annotation: CheckResult }> = [];
  for (const file of runResult.fileResults) {
    if (file.advisoryAnnotations) {
      for (const ann of file.advisoryAnnotations) {
        allAdvisory.push({ file: displayPath(file.path), annotation: ann });
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
    const sensitivityWarnings = computeSensitivityWarnings(runResult, config);
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
function computeSensitivityWarnings(runResult: RunResult, config: AgentConfig): string[] {
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
          `**${displayPath(file.path)}**: ${file.spanCategories.serviceEntryPoints} service entry point span(s) — review recommended (tier 3)`,
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
            `**${displayPath(file.path)}**: ${file.spansAdded} spans added (average: ${Math.round(mean)}) — outlier, review recommended`,
          );
        }
      }
    }
  }

  return warnings;
}

function renderAgentNotes(runResult: RunResult): string {
  const filesWithNotes = runResult.fileResults.filter(
    f => f.notes && f.notes.length > 0,
  );

  if (filesWithNotes.length === 0) return '';

  const lines: string[] = ['## Agent Notes'];
  lines.push('');

  for (const file of filesWithNotes) {
    lines.push(`**${displayPath(file.path)}**:`);
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

  const ceilingDollars = ceilingToDollars(runResult.costCeiling, config.agentModel);
  const actualDollars = tokensToDollars(runResult.actualTokenUsage, config.agentModel);

  lines.push('| | Ceiling | Actual |');
  lines.push('|---|---------|--------|');
  lines.push(`| **Cost** | ${formatDollars(ceilingDollars)} | ${formatDollars(actualDollars)} |`);
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

function renderWarnings(runResult: RunResult): string {
  if (runResult.warnings.length === 0) return '';

  const lines: string[] = ['## Warnings'];
  lines.push('');
  for (const warning of runResult.warnings) {
    lines.push(`- ${warning}`);
  }

  return lines.join('\n');
}

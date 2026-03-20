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
  sections.push(renderPerFileStatus(runResult, config, display));
  sections.push(renderSpanCategoryBreakdown(runResult, display));
  sections.push(renderSchemaChanges(runResult));
  sections.push(renderReviewSensitivity(runResult, config, display));
  sections.push(renderAgentNotes(runResult, display));
  sections.push(renderRecommendedRefactors(runResult, display));
  sections.push(renderRolledBackFiles(runResult, display));
  sections.push(renderCompanionPackages(runResult));
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
  const committed = runResult.fileResults.filter(r => r.status === 'success' && r.spansAdded > 0).length;
  const correctSkips = runResult.fileResults.filter(r => r.status === 'success' && r.spansAdded === 0).length;
  const lines: string[] = ['## Summary'];
  lines.push('');
  lines.push(`- **Files processed**: ${runResult.filesProcessed}`);
  lines.push(`- **Committed**: ${committed}`);
  if (correctSkips > 0) {
    lines.push(`- **Correct skips**: ${correctSkips}`);
  }
  if (runResult.filesFailed > 0) {
    lines.push(`- **Failed**: ${runResult.filesFailed}`);
  }
  if (runResult.filesPartial > 0) {
    lines.push(`- **Partial**: ${runResult.filesPartial}`);
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

function renderPerFileStatus(runResult: RunResult, config: AgentConfig, display: DisplayFn): string {
  // Separate zero-span success files (correct skips) from files with spans
  const zeroSpanFiles = runResult.fileResults.filter(f => f.status === 'success' && f.spansAdded === 0);
  const actionableFiles = runResult.fileResults.filter(f => !(f.status === 'success' && f.spansAdded === 0));

  const lines: string[] = ['## Per-File Results'];
  lines.push('');
  lines.push('| File | Status | Spans | Attempts | Cost | Libraries | Schema Extensions |');
  lines.push('|------|--------|-------|----------|------|-----------|-------------------|');

  for (const file of actionableFiles) {
    const name = display(file.path);
    let statusText: string;
    if (file.status === 'success') {
      statusText = 'success';
    } else if (file.status === 'failed') {
      statusText = file.reason ? `failed: ${sanitizeCell(file.reason)}` : 'failed';
    } else if (file.status === 'partial') {
      statusText = `partial (${file.functionsInstrumented ?? 0}/${(file.functionsInstrumented ?? 0) + (file.functionsSkipped ?? 0)} functions)`;
    } else {
      statusText = 'skipped';
    }
    // For failed files, libraries and extensions are from rejected agent output —
    // showing them misleads reviewers into thinking they're in the committed code.
    const isCommitted = file.status === 'success' || file.status === 'partial';
    const libs = isCommitted
      ? (file.librariesNeeded.map(l => `\`${l.package}\``).join(', ') || '—')
      : '—';
    const exts = isCommitted && file.schemaExtensions.length > 0
      ? file.schemaExtensions.map(e => `\`${sanitizeCell(e)}\``).join(', ')
      : '—';
    let costStr = '—';
    try {
      costStr = formatDollars(tokensToDollars(file.tokenUsage, config.agentModel));
    } catch {
      // Unknown model — leave as —
    }

    lines.push(`| ${name} | ${statusText} | ${file.spansAdded} | ${file.validationAttempts} | ${costStr} | ${libs} | ${exts} |`);
  }

  // Group zero-span files into a compact summary instead of individual rows
  if (zeroSpanFiles.length > 0) {
    const names = zeroSpanFiles.map(f => display(f.path)).join(', ');
    lines.push('');
    lines.push(`**Correct skips** (${zeroSpanFiles.length} files, 0 spans — no instrumentable functions): ${names}`);
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
  // Only show span categories for committed files — failed files carry
  // spanCategories from rejected agent output which doesn't reflect the branch.
  const filesWithCategories = runResult.fileResults.filter(
    (f): f is FileResult & { spanCategories: NonNullable<FileResult['spanCategories']> } =>
      f.spanCategories != null && (f.status === 'success' || f.status === 'partial'),
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

/**
 * Filter advisory annotations to remove COV-004 findings for functions
 * the agent deliberately chose not to instrument.
 *
 * A COV-004 finding is suppressed when the file's notes mention the function
 * name in a skip-decision context (containing "skip" or a restraint rule ID
 * like RST-001 through RST-005).
 */
function filterContradictingAdvisories(
  annotations: CheckResult[],
  notes: string[] | undefined,
): CheckResult[] {
  if (!notes || notes.length === 0) return annotations;

  const cov004 = annotations.filter(a => a.ruleId === 'COV-004');
  if (cov004.length === 0) return annotations;

  const other = annotations.filter(a => a.ruleId !== 'COV-004');

  const filteredCov004 = cov004.filter(ann => {
    // Extract function name from message: "functionName" (reason) at line N...
    const match = ann.message.match(/^"([^"]+)"/);
    if (!match) return true;
    const fnName = match[1];

    // Use word-boundary matching to avoid false suppression (e.g., "process" in "processOrder")
    const escaped = fnName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const fnPattern = new RegExp(`\\b${escaped}\\b`);

    // Suppress if any note mentions this function in a skip context
    const isSkipped = notes.some(note =>
      fnPattern.test(note) && /skip|RST-00[1-5]/i.test(note),
    );
    return !isSkipped;
  });

  return [...other, ...filteredCov004];
}

function renderReviewSensitivity(runResult: RunResult, config: AgentConfig, display: DisplayFn): string {
  const lines: string[] = [];

  // Collect advisory annotations from all files, filtering contradictions
  const allAdvisory: Array<{ file: string; annotation: CheckResult }> = [];
  for (const file of runResult.fileResults) {
    if (file.advisoryAnnotations) {
      const filtered = filterContradictingAdvisories(file.advisoryAnnotations, file.notes);
      for (const ann of filtered) {
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
      f.spanCategories != null && (f.status === 'success' || f.status === 'partial'),
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
  // Exclude zero-span success files — their notes are repetitive ("No instrumentable functions")
  // and already summarized in the per-file table's "Correct skips" line.
  const filesWithNotes = runResult.fileResults.filter(
    f => f.notes && f.notes.length > 0 && !(f.status === 'success' && f.spansAdded === 0),
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

function renderRecommendedRefactors(runResult: RunResult, display: DisplayFn): string {
  const oneLine = (value: string) => value.replace(/\r?\n/g, ' ').trim();
  const filesWithRefactors = runResult.fileResults.filter(
    f => f.suggestedRefactors && f.suggestedRefactors.length > 0,
  );

  if (filesWithRefactors.length === 0) return '';

  const lines: string[] = ['## Recommended Refactors'];
  lines.push('');
  lines.push('The following files failed instrumentation due to code patterns that block safe transforms. Apply these refactors, then re-run the agent on the affected files.');
  lines.push('');

  for (const file of filesWithRefactors) {
    lines.push(`### ${display(file.path)}`);
    lines.push('');
    for (const refactor of file.suggestedRefactors!) {
      const rules = refactor.unblocksRules.map(r => `\`${r}\``).join(', ');
      const loc = refactor.location.startLine === refactor.location.endLine
        ? `L${refactor.location.startLine}`
        : `L${refactor.location.startLine}–${refactor.location.endLine}`;
      lines.push(`- **${oneLine(refactor.description)}** (${loc})`);
      lines.push(`  - ${oneLine(refactor.reason)}`);
      lines.push(`  - Unblocks: ${rules}`);
    }
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

function renderRolledBackFiles(runResult: RunResult, display: DisplayFn): string {
  const rolledBack = runResult.fileResults.filter(
    f => f.status === 'failed' && f.reason?.startsWith('Rolled back:'),
  );

  if (rolledBack.length === 0) return '';

  const lines: string[] = ['## Rolled Back Files'];
  lines.push('');
  lines.push('The following files were rolled back to their pre-instrumentation state due to test failures.');
  lines.push('');
  lines.push('| File | Reason |');
  lines.push('|------|--------|');

  for (const file of rolledBack) {
    lines.push(`| ${display(file.path)} | ${sanitizeCell(file.reason ?? '')} |`);
  }

  return lines.join('\n');
}

function renderCompanionPackages(runResult: RunResult): string {
  if (!runResult.companionPackages || runResult.companionPackages.length === 0) return '';

  const lines: string[] = ['## Recommended Companion Packages'];
  lines.push('');
  lines.push(
    'This project was detected as a library. The following auto-instrumentation packages ' +
    'were identified but not added as dependencies — they are SDK-level concerns that ' +
    'deployers should add to their application\'s telemetry setup.',
  );
  lines.push('');
  for (const pkg of runResult.companionPackages) {
    lines.push(`- \`${pkg}\``);
  }

  return lines.join('\n');
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
  const filePath = join(projectDir, 'spiny-orb-pr-summary.md');
  await writeFile(filePath, content, 'utf-8');
  return filePath;
}

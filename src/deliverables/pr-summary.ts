// ABOUTME: Renders RunResult into a complete PR description in markdown.
// ABOUTME: Produces all spec-required sections: per-file status, span categories, schema diff, review sensitivity, notes, token usage, version.

import type { RunResult, EndOfRunFlagContext, LiveCheckStatus } from '../coordinator/types.ts';
import type { FileResult } from '../fix-loop/types.ts';
import type { AgentConfig } from '../config/schema.ts';
import type { CheckResult } from '../validation/types.ts';
import { tokensToDollars, ceilingToDollars, formatDollars } from './cost-formatting.ts';
import { writeFile } from 'node:fs/promises';
import { relative, basename, join } from 'node:path';
import { formatRuleId, expandRuleCodesInText, getRuleHumanDescription } from '../validation/rule-names.ts';

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
  sections.push(renderEndOfRunFlag(runResult, display));
  sections.push(renderRolledBackFiles(runResult, display));
  sections.push(renderCompanionPackages(runResult, config));
  sections.push(renderAutoInstrumentationActivation(runResult));
  sections.push(renderShortLivedSetupGuidance(config));
  sections.push(renderSdkBootstrapChecklist());
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
    lines.push(`- **No changes needed**: ${correctSkips}`);
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
    lines.push(`**No changes needed** (${zeroSpanFiles.length} files, 0 spans): ${names}`);
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

/**
 * Count new attribute-type schema extensions proposed by a file (as opposed to
 * span-type extensions, which are tracked separately by collectSpanExtensionIds).
 */
function countNewAttributeExtensions(file: FileResult): number {
  let count = 0;
  for (const ext of file.schemaExtensions) {
    const idMatch = ext.match(/id:\s*(\S+)/);
    const typeMatch = ext.match(/type:\s*(\S+)/);
    if (idMatch) {
      const id = idMatch[1];
      const isSpan = id.startsWith('span.') || typeMatch?.[1] === 'span';
      if (!isSpan) count++;
    } else {
      const trimmed = ext.trim();
      if (!trimmed.startsWith('span.')) count++;
    }
  }
  return count;
}

function renderSpanCategoryBreakdown(runResult: RunResult, display: DisplayFn): string {
  // Only show committed files with at least one span — failed/skipped files carry
  // spanCategories from rejected agent output that doesn't reflect the branch, and
  // zero-span files have nothing to categorize (they're already compressed in the
  // Per-File Results table).
  const committedFiles = runResult.fileResults.filter(
    f => (f.status === 'success' || f.status === 'partial') && f.spansAdded > 0,
  );

  if (committedFiles.length === 0) return '';

  const lines: string[] = ['## Span Category Breakdown'];
  lines.push('');
  lines.push(
    '*Self-reported by the LLM, not independently verified against the diff. ' +
      '"External Calls" counts manually-wrapped spans only — calls covered by an ' +
      'auto-instrumentation library are not included.*',
  );
  lines.push('');
  lines.push('| File | External Calls | Schema-Defined | Service Entry Points | Total Functions | Attrs Reused / New |');
  lines.push('|------|---------------|----------------|---------------------|-----------------|---------------------|');

  for (const file of committedFiles) {
    const name = display(file.path);
    const cats = file.spanCategories;
    const newAttrs = countNewAttributeExtensions(file);
    const reusedAttrs = Math.max(file.attributesCreated - newAttrs, 0);
    const attrsCell = `${reusedAttrs} / ${newAttrs}`;

    if (cats == null) {
      lines.push(`| ${name} | not reported | not reported | not reported | not reported | ${attrsCell} |`);
    } else {
      lines.push(
        `| ${name} | ${cats.externalCalls} | ${cats.schemaDefined} | ${cats.serviceEntryPoints} | ${cats.totalFunctionsInFile} | ${attrsCell} |`,
      );
    }
  }

  return lines.join('\n');
}

function renderSchemaChanges(runResult: RunResult): string {
  const lines: string[] = ['## Schema Changes'];
  lines.push('');

  if (runResult.schemaDiff) {
    // Only add a heading when the diff doesn't already contain its own ### headings.
    // Real Weaver output uses plain-text labels; test fixtures may contain markdown headers.
    if (!/^###\s/m.test(runResult.schemaDiff)) {
      lines.push('### New Attribute Keys');
      lines.push('');
    }
    lines.push(runResult.schemaDiff);
  } else {
    lines.push('No schema changes detected.');
  }

  // Supplement with span extension listing from committed files.
  // The weaver registry diff may not include individual span entries prominently,
  // so we list them explicitly from the FileResult schema extensions.
  const spanExtensions = collectSpanExtensionIds(runResult);
  if (spanExtensions.length > 0) {
    lines.push('');
    lines.push(`### New Span IDs (${spanExtensions.length})`);
    lines.push('');
    for (const spanId of spanExtensions) {
      lines.push(`- \`${spanId}\``);
    }
  }

  return lines.join('\n');
}

/**
 * Collect deduplicated span extension IDs from committed file results.
 * Span extensions have IDs starting with "span." or type "span".
 */
function collectSpanExtensionIds(runResult: RunResult): string[] {
  const seen = new Set<string>();
  for (const file of runResult.fileResults) {
    if (file.status !== 'success' && file.status !== 'partial') continue;
    for (const ext of file.schemaExtensions) {
      // Extensions come in two formats:
      // 1. YAML-like: "id: span.myapp.op\ntype: span"
      // 2. Bare string: "span.myapp.op" (from supplementSchemaExtensions)
      const idMatch = ext.match(/id:\s*(\S+)/);
      const typeMatch = ext.match(/type:\s*(\S+)/);

      if (idMatch) {
        const id = idMatch[1];
        const isSpan = id.startsWith('span.') || typeMatch?.[1] === 'span';
        if (isSpan && !seen.has(id)) {
          seen.add(id);
        }
      } else {
        // Bare string — check if it's a span extension directly
        const trimmed = ext.trim();
        if (trimmed.startsWith('span.') && !seen.has(trimmed)) {
          seen.add(trimmed);
        }
      }
    }
  }
  return [...seen].sort();
}

/**
 * Coverage and quality rule IDs that should be suppressed when the agent
 * deliberately skipped a function per restraint rules (RST-001 through RST-005).
 * Advisories for these rules on skipped functions are contradictions —
 * the agent can't satisfy both "skip this" and "cover this."
 */
const SUPPRESSIBLE_ADVISORY_RULES = new Set([
  'COV-001', 'COV-002', 'COV-004', 'COV-005',
  'CDQ-003', 'NDS-005',
]);

/**
 * Filter advisory annotations to remove coverage/quality findings for functions
 * the agent deliberately chose not to instrument.
 *
 * A finding is suppressed when its rule is in the suppressible set AND the file's
 * notes mention the function name in a skip-decision context (containing "skip"
 * or a restraint rule ID like RST-001 through RST-005).
 */
function filterContradictingAdvisories(
  annotations: CheckResult[],
  notes: string[] | undefined,
): CheckResult[] {
  if (!notes || notes.length === 0) return annotations;

  return annotations.filter(ann => {
    if (!SUPPRESSIBLE_ADVISORY_RULES.has(ann.ruleId)) return true;

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
}

function renderReviewSensitivity(runResult: RunResult, config: AgentConfig, display: DisplayFn): string {
  const lines: string[] = [];

  // Collect advisory annotations from all files, filtering contradictions.
  // Track both canonical path (for deduplication) and display path (for rendering)
  // to avoid undercounting when different directories share basenames.
  const allAdvisory: Array<{ filePath: string; fileDisplay: string; annotation: CheckResult }> = [];
  for (const file of runResult.fileResults) {
    if (file.advisoryAnnotations) {
      const filtered = filterContradictingAdvisories(file.advisoryAnnotations, file.notes);
      for (const ann of filtered) {
        allAdvisory.push({ filePath: file.path, fileDisplay: display(file.path), annotation: ann });
      }
    }
  }

  // Run-level advisory findings
  if (runResult.runLevelAdvisory.length > 0) {
    for (const ann of runResult.runLevelAdvisory) {
      allAdvisory.push({ filePath: '(run-level)', fileDisplay: '(run-level)', annotation: ann });
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

  // Advisory annotations section — group identical advisories by rule + message
  if (allAdvisory.length > 0) {
    if (lines.length === 0) {
      lines.push('## Review Attention');
      lines.push('');
    } else {
      lines.push('');
    }
    lines.push('### Advisory Findings');
    lines.push('');

    // Group by file so reviewers can navigate finding by finding within each file.
    const fileGroups = new Map<string, { fileDisplay: string; annotations: CheckResult[] }>();
    for (const { filePath, fileDisplay, annotation } of allAdvisory) {
      const existing = fileGroups.get(filePath);
      if (existing) {
        existing.annotations.push(annotation);
      } else {
        fileGroups.set(filePath, { fileDisplay, annotations: [annotation] });
      }
    }

    const fileEntries = [...fileGroups.entries()];
    for (let i = 0; i < fileEntries.length; i++) {
      const [, { fileDisplay, annotations }] = fileEntries[i];
      lines.push(`**${fileDisplay}**`);
      for (const ann of annotations) {
        // Prefer human-facing description when registered; fall back to the agent-facing message.
        // Agent-facing messages are terse and directive (written for the fix-loop, not for humans).
        // Human descriptions are registered in RULE_HUMAN_DESCRIPTIONS in rule-names.ts (M4/M5).
        const humanDesc = getRuleHumanDescription(ann.ruleId);
        const displayText = humanDesc
          ?? expandRuleCodesInText(ann.message.replace(/^[A-Z]{2,4}-\d{3}[a-z]?:\s*/, ''));
        lines.push(`- ${formatRuleId(ann.ruleId)}: ${displayText}`);
      }
      if (i < fileEntries.length - 1) {
        lines.push('');
      }
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
  // Only show the pointer when at least one committed file has notes — failed files
  // may not have a companion .instrumentation.md if they were never written to disk.
  const filesWithNotes = runResult.fileResults.filter(
    f => f.notes && f.notes.length > 0 && (f.status === 'success' || f.status === 'partial') && f.spansAdded > 0,
  );

  if (filesWithNotes.length === 0) return '';

  return [
    '## Agent Notes',
    '',
    "Each instrumented file has a companion `.instrumentation.md` file in the same directory " +
    '(e.g., `src/api.js` → `src/api.instrumentation.md`) containing the agent\'s full decision notes.',
  ].join('\n');
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
      const rules = refactor.unblocksRules.map(r => `\`${formatRuleId(r)}\``).join(', ');
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

/** Make failureMessage safe for markdown inline code: first line only, no backticks. */
function sanitizeForInlineCode(text: string): string {
  return text.split('\n')[0].replace(/`/g, "'");
}

function renderEndOfRunFlag(runResult: RunResult, display: DisplayFn): string {
  const flag = runResult.endOfRunFlag;
  if (!flag) return '';

  const lines: string[] = ['## Test Failure Analysis'];
  lines.push('');
  lines.push(`**End-of-run tests failed.** Instrumented files were kept — this is not a direct error in agent-added code.`);
  lines.push('');
  lines.push(`**Failure:** \`${sanitizeForInlineCode(flag.failureMessage)}\``);
  lines.push('');
  lines.push('**Files in call path:**');
  for (const file of flag.filesInCallPath) {
    lines.push(`- ${display(file)}`);
  }

  if (flag.apiHealth !== undefined) {
    lines.push('');
    const healthMsg = flag.apiHealth.reachable
      ? `${flag.apiHealth.registry} registry was reachable — failure is unlikely environmental.`
      : `${flag.apiHealth.registry} registry was unreachable at test time — likely environmental.`;
    lines.push(`**API health:** ${healthMsg}`);
  }

  if (flag.retryResult !== undefined) {
    lines.push('');
    const retryMsg = flag.retryResult.passed
      ? 'Test suite passed on retry — likely transient.'
      : 'Test suite failed on retry — persistent failure.';
    lines.push(`**Retry:** ${retryMsg}`);
  }

  lines.push('');
  lines.push('Human review recommended before merging. Diff the files above against their pre-instrumentation state.');

  return lines.join('\n');
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

function renderCompanionPackages(runResult: RunResult, config: AgentConfig): string {
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

  lines.push('');
  lines.push(
    '> **Important**: Initialize these packages **inside your application code**, not via `--import`. ' +
    'Loading them through `--import` can install a competing ESM hook registry alongside the one ' +
    'already registered by your OTel SDK, causing spans to be created but silently dropped — ' +
    'the exporter reports success but data never reaches the backend.',
  );

  if (config.targetType === 'short-lived') {
    lines.push('');
    lines.push(
      '> See the Short-Lived Process Setup Guidance section below for additional setup details.',
    );
  }

  return lines.join('\n');
}

function renderAutoInstrumentationActivation(runResult: RunResult): string {
  if (runResult.librariesInstalled.length === 0) return '';

  const lines: string[] = ['## Auto-Instrumentation Activation'];
  lines.push('');
  lines.push(
    'spiny-orb installed the following auto-instrumentation packages. ' +
    'They must be activated in your application startup to take effect:',
  );
  lines.push('');
  lines.push('```bash');
  lines.push(`npm install ${runResult.librariesInstalled.join(' ')}`);
  lines.push('```');
  lines.push('');

  if (runResult.sdkInitUpdated) {
    lines.push(
      'The instrumentations were registered in your **SDK init file**. ' +
      'Import that file via `--import` before your application code runs.',
    );
  } else {
    lines.push(
      'The instrumentations were written to **`spiny-orb-instrumentations.js`** ' +
      'because your SDK init file did not match the recognized NodeSDK pattern. ' +
      'Add the contents of that file to your OpenTelemetry SDK setup manually.',
    );
  }

  const traceloopPkgs = runResult.librariesInstalled.filter(p => p.startsWith('@traceloop/'));
  if (traceloopPkgs.length > 0) {
    lines.push('');
    lines.push(
      '**@traceloop packages — conditional activation:** ' +
      'These packages were installed: ' +
      traceloopPkgs.map(p => `\`${p}\``).join(', ') + '. ' +
      'Traceloop instrumentations use `manuallyInstrument()` and should be activated behind ' +
      'a `process.env` check so they only run in environments where you want AI/LLM traces:',
    );
    lines.push('');
    lines.push('```javascript');
    lines.push('if (process.env.YOUR_TRACELOOP_FLAG === \'true\') {');
    for (const pkg of traceloopPkgs) {
      lines.push(`  // activate ${pkg}`);
    }
    lines.push('}');
    lines.push('```');
  }

  return lines.join('\n');
}

function renderShortLivedSetupGuidance(config: AgentConfig): string {
  if (config.targetType !== 'short-lived') return '';

  const lines: string[] = ['## Short-Lived Process Setup Guidance'];
  lines.push('');
  lines.push(
    'This project is configured as a short-lived process (`targetType: short-lived`). ' +
    'CLIs, scripts, Lambda functions, and batch jobs need special telemetry setup ' +
    'to ensure spans are exported before the process exits.',
  );
  lines.push('');
  lines.push('### Span Processor');
  lines.push('');
  lines.push(
    'Use `SimpleSpanProcessor` instead of the default `BatchSpanProcessor`. ' +
    'Batch processing delays export by up to 5 seconds — a CLI that finishes in under 5 seconds ' +
    'will exit before the batch timer fires, losing all spans silently.',
  );
  lines.push('');
  lines.push('```javascript');
  lines.push("import { SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';");
  lines.push("import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';");
  lines.push('');
  lines.push('spanProcessors: [new SimpleSpanProcessor(new OTLPTraceExporter({');
  lines.push("  url: 'http://localhost:4318/v1/traces',");
  lines.push('}))]');
  lines.push('```');
  lines.push('');
  lines.push('### process.exit Interception');
  lines.push('');
  lines.push(
    'If your application calls `process.exit()`, intercept it to flush spans before terminating:',
  );
  lines.push('');
  lines.push('```javascript');
  lines.push('let isShuttingDown = false;');
  lines.push('const originalExit = process.exit;');
  lines.push('process.exit = (code) => {');
  lines.push('  if (isShuttingDown) return originalExit.call(process, code);');
  lines.push('  isShuttingDown = true;');
  lines.push('  process.exitCode = code ?? 0;');
  lines.push('  sdk.shutdown()');
  lines.push("    .catch((err) => console.error('OTel SDK shutdown error:', err))");
  lines.push('    .then(() => new Promise(resolve => setTimeout(resolve, 1000)))');
  lines.push('    .finally(() => originalExit.call(process, process.exitCode));');
  lines.push('};');
  lines.push('```');

  return lines.join('\n');
}

function renderSdkBootstrapChecklist(): string {
  const lines: string[] = ['## SDK Bootstrap Checklist'];
  lines.push('');
  lines.push(
    'Verify that your SDK init file includes all required resource attributes. ' +
    "Missing attributes reduce observability and cause RES-001 compliance failures.",
  );
  lines.push('');
  lines.push('```javascript');
  lines.push("import { randomUUID } from 'node:crypto';");
  lines.push('');
  lines.push('resource: resourceFromAttributes({');
  lines.push("  'service.name': 'your-service-name',");
  lines.push("  'service.version': process.env.npm_package_version || '0.0.0',");
  lines.push("  'service.instance.id': randomUUID(),");
  lines.push('}),');
  lines.push('```');
  lines.push('');
  lines.push(
    '> **`service.instance.id`** uniquely identifies a running process instance. ' +
    'Without it, traces from different deployments share identical resource metadata — ' +
    "spans are indistinguishable across restarts and parallel processes.",
  );

  return lines.join('\n');
}

function renderTokenUsage(runResult: RunResult, config: AgentConfig): string {
  const lines: string[] = ['## Token Usage'];
  lines.push('');

  let costRow: string;
  try {
    const ceilingDollars = ceilingToDollars(runResult.costCeiling, config.agentModel);
    const actualDollars = tokensToDollars(runResult.actualTokenUsage, config.agentModel);
    costRow = `| **Cost** | ${formatDollars(ceilingDollars)} | ${formatDollars(actualDollars)} (${config.agentModel}) |`;
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
  const { liveCheckStatus, endOfRunValidation } = runResult;

  // No live-check data at all — omit section
  if (!liveCheckStatus && !endOfRunValidation) return '';

  const lines: string[] = ['## Live-Check Compliance'];
  lines.push('');

  if (liveCheckStatus) {
    lines.push(formatLiveCheckStatusLine(liveCheckStatus));
    // Link to artifact file when spans were received — never embed raw JSON in the PR body
    // (raw reports can reach hundreds of megabytes and cause E2BIG on gh pr create).
    if (liveCheckStatus.spansReceived && endOfRunValidation) {
      lines.push('');
      lines.push(`Full compliance report: \`${LIVE_CHECK_ARTIFACT_FILENAME}\``);
    }
  } else if (endOfRunValidation) {
    // Backward compat: no liveCheckStatus but raw report present
    lines.push(endOfRunValidation);
  }

  return lines.join('\n');
}

function formatLiveCheckStatusLine(status: LiveCheckStatus): string {
  if (status.sdkInjectionTestsFailed) {
    const spanInfo = status.spanCount > 0 ? `${status.spanCount} spans emitted before failure; ` : '';
    return `Live-Check: WARNING — tests failed after SDK injection (${spanInfo}see test output for details)`;
  }
  if (status.spansReceived) {
    if (status.totalAdvisories === 0) {
      return `Live-Check: OK (${status.spanCount} spans passed compliance)`;
    }
    const plural = status.totalAdvisories === 1 ? 'finding' : 'findings';
    return `Live-Check: OK (${status.spanCount} spans, ${status.totalAdvisories} advisory ${plural} — see compliance report)`;
  }
  return 'Live-Check: OK (no spans received — live-check did not validate any telemetry)';
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

/** Filename for the raw Weaver live-check compliance report artifact. */
export const LIVE_CHECK_ARTIFACT_FILENAME = 'spiny-orb-live-check-report.json';

/**
 * Write the raw Weaver compliance report JSON to a named artifact file.
 * Separates the full report from the PR body so the body stays small.
 *
 * @param projectDir - Project root directory
 * @param report - Raw compliance report JSON string from Weaver
 * @returns Absolute path to the written artifact file
 */
export async function writeLiveCheckArtifact(projectDir: string, report: string): Promise<string> {
  const filePath = join(projectDir, LIVE_CHECK_ARTIFACT_FILENAME);
  await writeFile(filePath, report, 'utf-8');
  return filePath;
}

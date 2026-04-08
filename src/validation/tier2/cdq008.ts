// ABOUTME: CDQ-008 Tier 2 check — consistent tracer naming convention.
// ABOUTME: Cross-file check that collects trace.getTracer() names and flags inconsistent patterns.

import type { CheckResult } from '../types.ts';
import type { ValidationRule } from '../../languages/types.ts';

/**
 * Input for cross-file tracer naming consistency check.
 */
export interface FileContent {
  filePath: string;
  code: string;
}

/** Pattern category for a tracer name. */
type NamingPattern = 'dotted-path' | 'module-name' | 'other';

/**
 * CDQ-008: Verify consistent tracer naming convention across all files.
 *
 * Collects all `trace.getTracer("name")` calls across files, classifies
 * each name into a pattern category (dotted-path, module-name, other),
 * and flags if more than one pattern category is detected.
 *
 * This is a per-run check that requires multi-file context.
 *
 * @param files - Array of file contents from the instrumentation run
 * @returns CheckResult with ruleId "CDQ-008", tier 2, blocking false
 */
export function checkTracerNamingConsistency(files: FileContent[]): CheckResult {
  const tracerNames: Array<{ name: string; filePath: string; pattern: NamingPattern }> = [];

  for (const file of files) {
    const names = extractTracerNames(file.code);
    for (const name of names) {
      tracerNames.push({
        name,
        filePath: file.filePath,
        pattern: classifyPattern(name),
      });
    }
  }

  // No tracer calls found — nothing to check
  if (tracerNames.length === 0) {
    return {
      ruleId: 'CDQ-008',
      passed: true,
      filePath: '<run-level>',
      lineNumber: null,
      message: 'No trace.getTracer() calls found.',
      tier: 2,
      blocking: false,
    };
  }

  // Collect unique patterns
  const patterns = new Set(tracerNames.map((t) => t.pattern));

  if (patterns.size <= 1) {
    return {
      ruleId: 'CDQ-008',
      passed: true,
      filePath: '<run-level>',
      lineNumber: null,
      message: 'All tracer names follow a consistent naming pattern.',
      tier: 2,
      blocking: false,
    };
  }

  // Group by pattern for reporting
  const byPattern = new Map<NamingPattern, Array<{ name: string; filePath: string }>>();
  for (const entry of tracerNames) {
    const group = byPattern.get(entry.pattern) ?? [];
    group.push({ name: entry.name, filePath: entry.filePath });
    byPattern.set(entry.pattern, group);
  }

  const details = [...byPattern.entries()]
    .map(([pattern, entries]) => {
      const examples = entries
        .map((e) => `"${e.name}" in ${e.filePath}`)
        .join(', ');
      return `  - ${pattern}: ${examples}`;
    })
    .join('\n');

  return {
    ruleId: 'CDQ-008',
    passed: false,
    filePath: '<run-level>',
    lineNumber: null,
    message:
      `CDQ-008 advisory: inconsistent tracer naming patterns detected across ${patterns.size} categories.\n` +
      `${details}\n` +
      `Choose a single naming convention for trace.getTracer() across all files. ` +
      `Common patterns: dotted-path ("com.myapp.module"), module-name ("my-service").`,
    tier: 2,
    blocking: false,
  };
}

/**
 * Extract tracer names from trace.getTracer("name") calls using regex.
 * Uses text matching rather than AST for simplicity — tracer names are
 * always string literals in conventional usage.
 */
function extractTracerNames(code: string): string[] {
  const names: string[] = [];
  // Match trace.getTracer("name") or trace.getTracer('name')
  const pattern = /\.getTracer\(\s*["']([^"']+)["']/g;
  let match;
  while ((match = pattern.exec(code)) !== null) {
    names.push(match[1]);
  }
  return names;
}

/**
 * Classify a tracer name into a naming pattern category.
 * - dotted-path: "com.myapp.users" (contains dots)
 * - module-name: "my-service" or "user_service" (kebab-case or snake_case, no dots)
 * - other: anything else
 */
function classifyPattern(name: string): NamingPattern {
  if (name.includes('.')) {
    return 'dotted-path';
  }
  // kebab-case, snake_case, or simple identifier
  if (/^[a-z][a-z0-9_-]*$/i.test(name)) {
    return 'module-name';
  }
  return 'other';
}

/**
 * CDQ-008 per-file ValidationRule.
 *
 * CDQ-008 is inherently a cross-file check — it verifies naming consistency
 * across all files in a run, not within a single file. The actual check runs
 * at coordinator level via `checkTracerNamingConsistency(files)`.
 *
 * This per-file rule always passes. It exists so CDQ-008 appears in the
 * rule registry and the feature parity matrix can verify the provider
 * has an implementation of this rule concept.
 *
 * Applies to all languages (tracer naming consistency is a universal concern).
 */
export const cdq008Rule: ValidationRule = {
  ruleId: 'CDQ-008',
  dimension: 'Code Quality',
  blocking: false,
  applicableTo(_language: string): boolean {
    return true;
  },
  check(input) {
    // Per-file: always passes. The real cross-file check runs in coordinate.ts.
    return {
      ruleId: 'CDQ-008',
      passed: true,
      filePath: input.filePath,
      lineNumber: null,
      message: 'CDQ-008: Cross-file tracer naming check runs at coordinator level.',
      tier: 2,
      blocking: false,
    };
  },
};

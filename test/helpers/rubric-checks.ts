// ABOUTME: Rubric check helpers for acceptance gate verification.
// ABOUTME: One function per rubric rule — verifies instrumented code meets quality criteria.

import { execFileSync } from 'node:child_process';
import { writeFileSync, unlinkSync, mkdtempSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Project, Node } from 'ts-morph';
import type { SourceFile, SyntaxKind as SyntaxKindType, TryStatement } from 'ts-morph';

/** Result of a rubric check. */
interface RubricCheckResult {
  passed: boolean;
  details?: string;
}

/**
 * NDS-001: Syntax validation — `node --check` exits 0.
 */
export function checkSyntaxValid(code: string): RubricCheckResult {
  const dir = mkdtempSync(join(tmpdir(), 'spiny-orb-nds001-'));
  const filePath = join(dir, 'check.js');
  try {
    writeFileSync(filePath, code, 'utf-8');
    execFileSync('node', ['--check', filePath], { timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] });
    return { passed: true };
  } catch (error) {
    const message = error instanceof Error ? (error as any).stderr?.toString() ?? error.message : String(error);
    return { passed: false, details: `node --check failed: ${message}` };
  } finally {
    try { unlinkSync(filePath); } catch { /* ignore cleanup errors */ }
    try { rmdirSync(dir); } catch { /* ignore cleanup errors */ }
  }
}

/**
 * NDS-003: Non-instrumentation lines unchanged.
 * Every non-blank, non-instrumentation line from the original should appear in the
 * instrumented output (after trimming whitespace, to allow for indentation changes
 * from wrapping). Checks both presence and relative ordering to detect modifications
 * as well as deletions.
 */
export function checkNonInstrumentationLinesUnchanged(
  original: string,
  instrumented: string,
): RubricCheckResult {
  const originalLines = original.split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0)
    .filter(l => !l.startsWith('// ABOUTME:'));

  const instrumentedTrimmed = instrumented.split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0);

  // Filter instrumented lines to non-OTel lines for ordering check
  const instrumentedNonOtel = instrumentedTrimmed.filter(l => !isOTelLine(l));

  const missingLines: string[] = [];
  const instrumentedSet = new Set(instrumentedTrimmed);

  // Presence check: every original line must appear somewhere in the output
  for (const line of originalLines) {
    if (!instrumentedSet.has(line)) {
      missingLines.push(line);
    }
  }

  if (missingLines.length > 0) {
    return {
      passed: false,
      details: `Original lines missing from instrumented output:\n${missingLines.map(l => `  - ${l}`).join('\n')}`,
    };
  }

  // Ordering check: original lines should appear in the same relative order
  // in the non-OTel portion of the instrumented output
  const reorderedLines: string[] = [];
  let searchFrom = 0;
  for (const line of originalLines) {
    const idx = instrumentedNonOtel.indexOf(line, searchFrom);
    if (idx === -1) {
      // Line was present (passed presence check) but not found in order —
      // it may have been moved relative to other original lines
      reorderedLines.push(line);
    } else {
      searchFrom = idx + 1;
    }
  }

  if (reorderedLines.length > 0) {
    return {
      passed: false,
      details: `Original lines were reordered in instrumented output:\n${reorderedLines.map(l => `  - ${l}`).join('\n')}`,
    };
  }

  return { passed: true };
}

/**
 * NDS-004: Public API signatures preserved.
 * All exported function names from the original must exist in the instrumented output
 * with the same parameter count.
 */
export function checkPublicApiPreserved(
  original: string,
  instrumented: string,
): RubricCheckResult {
  const project = new Project({ compilerOptions: { allowJs: true }, useInMemoryFileSystem: true });
  const origFile = project.createSourceFile('original.js', original);
  const instFile = project.createSourceFile('instrumented.js', instrumented);

  const getExportedFunctions = (sf: SourceFile) => {
    const fns: Array<{ name: string; paramCount: number; isAsync: boolean }> = [];

    for (const fn of sf.getFunctions()) {
      if (fn.isExported()) {
        fns.push({
          name: fn.getName() ?? '<anonymous>',
          paramCount: fn.getParameters().length,
          isAsync: fn.isAsync(),
        });
      }
    }

    // Also check variable declarations with arrow functions
    for (const stmt of sf.getVariableStatements()) {
      if (!stmt.isExported()) continue;
      for (const decl of stmt.getDeclarations()) {
        const init = decl.getInitializer();
        if (init && (init.getKindName() === 'ArrowFunction' || init.getKindName() === 'FunctionExpression')) {
          fns.push({
            name: decl.getName(),
            paramCount: (init as any).getParameters?.()?.length ?? 0,
            isAsync: init.getText().startsWith('async'),
          });
        }
      }
    }

    return fns;
  };

  const origFns = getExportedFunctions(origFile);
  const instFns = getExportedFunctions(instFile);

  const differences: string[] = [];
  for (const origFn of origFns) {
    const instFn = instFns.find(f => f.name === origFn.name);
    if (!instFn) {
      differences.push(`Exported function '${origFn.name}' is missing from instrumented output`);
      continue;
    }
    if (instFn.paramCount !== origFn.paramCount) {
      differences.push(`'${origFn.name}' parameter count changed: ${origFn.paramCount} -> ${instFn.paramCount}`);
    }
    if (instFn.isAsync !== origFn.isAsync) {
      differences.push(`'${origFn.name}' async changed: ${origFn.isAsync} -> ${instFn.isAsync}`);
    }
  }

  if (differences.length === 0) {
    return { passed: true };
  }
  return { passed: false, details: differences.join('\n') };
}

/**
 * NDS-005: Error handling behavior preserved.
 * Pre-existing try/catch blocks should still be present. Catch clause bodies
 * (excluding OTel additions) should be unchanged.
 */
export function checkErrorHandlingPreserved(
  original: string,
  instrumented: string,
): RubricCheckResult {
  // Extract catch clause body content from original (trimmed, non-empty lines)
  const catchContentRegex = /catch\s*\([^)]*\)\s*\{([^}]*(?:\{[^}]*\}[^}]*)*)\}/g;

  const originalCatches: string[] = [];
  let match;
  while ((match = catchContentRegex.exec(original)) !== null) {
    const body = match[1].trim();
    if (body) originalCatches.push(body);
  }

  if (originalCatches.length === 0) {
    return { passed: true };
  }

  // Each original catch body's non-OTel lines should appear in the instrumented output
  const instrumentedText = instrumented;
  const missingContent: string[] = [];

  for (const catchBody of originalCatches) {
    const lines = catchBody.split('\n')
      .map(l => l.trim())
      .filter(l => l.length > 0)
      .filter(l => !isOTelLine(l));

    for (const line of lines) {
      if (!instrumentedText.includes(line)) {
        missingContent.push(line);
      }
    }
  }

  if (missingContent.length === 0) {
    return { passed: true };
  }
  return {
    passed: false,
    details: `Original catch block content missing:\n${missingContent.map(l => `  - ${l}`).join('\n')}`,
  };
}

/**
 * API-001: All @opentelemetry imports must be from @opentelemetry/api only.
 */
export function checkOtelImportsApiOnly(code: string): RubricCheckResult {
  const importRegex = /from\s+['"](@opentelemetry\/[^'"]+)['"]/g;
  const invalidImports: string[] = [];

  let match;
  while ((match = importRegex.exec(code)) !== null) {
    if (match[1] !== '@opentelemetry/api') {
      invalidImports.push(match[1]);
    }
  }

  if (invalidImports.length === 0) {
    return { passed: true };
  }
  return {
    passed: false,
    details: `Invalid OTel imports (must be @opentelemetry/api only): ${invalidImports.join(', ')}`,
  };
}

/**
 * CDQ-001: Spans closed in all code paths.
 * Every startActiveSpan/startSpan call must have span.end() in a finally block.
 */
export function checkSpansClosed(code: string): RubricCheckResult {
  // Count span open patterns
  const spanOpenCount = (code.match(/\.startActiveSpan\s*\(/g) || []).length
    + (code.match(/\.startSpan\s*\(/g) || []).length;

  if (spanOpenCount === 0) {
    return { passed: true };
  }

  // Count span.end() in finally blocks using brace-counting to handle nested braces
  const finallyEndCount = countSpanEndInFinallyBlocks(code);

  if (finallyEndCount >= spanOpenCount) {
    return { passed: true };
  }

  return {
    passed: false,
    details: `Found ${spanOpenCount} span opens but only ${finallyEndCount} span.end() calls in finally blocks`,
  };
}

/**
 * Extract finally block bodies using ts-morph AST parsing,
 * then count how many contain .end() calls.
 */
function countSpanEndInFinallyBlocks(code: string): number {
  const project = new Project({ compilerOptions: { allowJs: true }, useInMemoryFileSystem: true });
  const sourceFile = project.createSourceFile('check-spans.js', code);
  let count = 0;

  sourceFile.forEachDescendant((node) => {
    if (Node.isTryStatement(node)) {
      const finallyBlock = node.getFinallyBlock();
      if (finallyBlock) {
        const finallyText = finallyBlock.getText();
        if (/\.end\(\)/.test(finallyText)) {
          count++;
        }
      }
    }
  });

  return count;
}

/**
 * CDQ-002: Tracer acquired correctly with a string argument.
 */
export function checkTracerAcquired(code: string): RubricCheckResult {
  const tracerCalls = code.match(/trace\.getTracer\s*\(([^)]*)\)/g);
  if (!tracerCalls || tracerCalls.length === 0) {
    // If no tracer calls and no spans, that's fine (e.g., auto-instrumentation only)
    const hasSpans = /\.startActiveSpan|\.startSpan/.test(code);
    if (hasSpans) {
      return { passed: false, details: 'Spans found but no trace.getTracer() call' };
    }
    return { passed: true };
  }

  const issues: string[] = [];
  for (const call of tracerCalls) {
    const argMatch = call.match(/trace\.getTracer\s*\(\s*(['"][^'"]+['"])/);
    if (!argMatch) {
      issues.push(`trace.getTracer() call without string argument: ${call}`);
    }
  }

  if (issues.length === 0) {
    return { passed: true };
  }
  return { passed: false, details: issues.join('\n') };
}

/**
 * CDQ-003: Standard error recording pattern.
 * Catch blocks should use span.recordException() + span.setStatus({ code: SpanStatusCode.ERROR }).
 */
export function checkErrorRecording(code: string): RubricCheckResult {
  // Find catch blocks that contain span references
  const hasSpanInCatch = /catch\s*\([^)]*\)\s*\{[^}]*(?:span|otelSpan)\./;

  if (!hasSpanInCatch.test(code)) {
    // No span usage in catch blocks — check if there are spans at all
    const hasSpans = /\.startActiveSpan|\.startSpan/.test(code);
    if (!hasSpans) return { passed: true };
    // If there are spans but no error handling, that's a problem
    // but only if there are catch blocks
    const hasCatch = /catch\s*\(/.test(code);
    if (!hasCatch) {
      // Spans without catch blocks are acceptable — error recording is only required when catching
      return { passed: true };
    }
  }

  // Check that recordException and setStatus patterns exist
  const hasRecordException = /\.recordException\s*\(/.test(code);
  const hasSetStatus = /\.setStatus\s*\(\s*\{[^}]*code:\s*SpanStatusCode\.ERROR/.test(code);

  const issues: string[] = [];
  if (!hasRecordException) {
    issues.push('Missing span.recordException() in error handling');
  }
  if (!hasSetStatus) {
    issues.push('Missing span.setStatus({ code: SpanStatusCode.ERROR }) in error handling');
  }

  if (issues.length === 0) {
    return { passed: true };
  }
  return { passed: false, details: issues.join('\n') };
}

/**
 * CDQ-005: startActiveSpan preferred over startSpan.
 * startActiveSpan automatically sets the span as active in context — passes.
 * tracer.startSpan() is advisory: the agent should prefer startActiveSpan
 * unless one of the four legitimate scenarios applies.
 */
export function checkAsyncContext(code: string): RubricCheckResult {
  // Flag tracer.startSpan() calls — startActiveSpan is preferred because it
  // automatically manages active span context so child operations are correctly parented.
  const tracerStartSpanMatches = code.match(/(?:tracer\w*|getTracer\s*\([^)]*\))\s*(?:\.\s*)\s*startSpan\s*\(/gi);
  if (tracerStartSpanMatches && tracerStartSpanMatches.length > 0) {
    return {
      passed: false,
      details: `Found ${tracerStartSpanMatches.length} tracer.startSpan() call(s) — prefer startActiveSpan() which automatically manages active span context`,
    };
  }

  return { passed: true };
}

/**
 * CDQ-007: No unbounded or PII attributes.
 * Flag setAttribute calls with JSON.stringify, object spreads, or PII field patterns.
 */
export function checkAttributeSafety(code: string): RubricCheckResult {
  const issues: string[] = [];

  // Check for JSON.stringify in setAttribute
  if (/\.setAttribute\s*\([^)]*JSON\.stringify/.test(code)) {
    issues.push('setAttribute uses JSON.stringify — may produce unbounded attribute values');
  }

  // Check for object spread in setAttribute
  if (/\.setAttribute\s*\([^)]*\.\.\./.test(code)) {
    issues.push('setAttribute uses object spread — unbounded attribute values');
  }

  // Check for PII field patterns in attribute keys
  const piiPatterns = ['email', 'password', 'ssn', 'phone', 'creditcard', 'credit_card', 'address'];
  const setAttrRegex = /\.setAttribute\s*\(\s*['"]([^'"]+)['"]/g;
  let match;
  while ((match = setAttrRegex.exec(code)) !== null) {
    const attrKey = match[1].toLowerCase();
    for (const pii of piiPatterns) {
      if (attrKey.includes(pii)) {
        issues.push(`setAttribute key '${match[1]}' matches PII pattern '${pii}'`);
      }
    }
  }

  // Check for optional chaining in setAttribute value arguments
  const optionalChainRegex = /\.setAttribute\s*\([^,]+,\s*[^)]*\?\./g;
  if (optionalChainRegex.test(code)) {
    issues.push('setAttribute uses optional chaining (?.) — value may be undefined');
  }

  if (issues.length === 0) {
    return { passed: true };
  }
  return { passed: false, details: issues.join('\n') };
}

/**
 * NDS-005b: Expected-condition catch blocks must not gain error recording.
 * Catch blocks in the instrumented output that contain ONLY OTel statements
 * (no original business logic) are NDS-005b violations — the agent added
 * span.recordException() to a catch block that was originally empty or
 * swallowed an expected condition (e.g., "file not found, proceed").
 */
export function checkNds005bNotViolated(instrumented: string): RubricCheckResult {
  const project = new Project({ compilerOptions: { allowJs: true }, useInMemoryFileSystem: true });
  const sf = project.createSourceFile('nds005b-check.js', instrumented);

  const violations: string[] = [];

  sf.forEachDescendant((node) => {
    if (Node.isTryStatement(node)) {
      const catchClause = node.getCatchClause();
      if (catchClause) {
        const statements = catchClause.getBlock().getStatements();
        if (statements.length === 0) return;

        const hasRecordException = statements.some((s: { getText(): string }) =>
          s.getText().includes('recordException'),
        );
        if (!hasRecordException) return;

        // Check if ALL statements are OTel calls — no original business logic survived
        const nonOtelStatements = statements.filter((s: { getText(): string }) => !isOTelStatement(s.getText().trim()));
        if (nonOtelStatements.length === 0) {
          violations.push(
            `Catch block at line ${catchClause.getStartLineNumber()} has only OTel error recording ` +
            `with no original business logic — likely an expected-condition catch (NDS-005b)`,
          );
        }
      }
    }
  });

  if (violations.length === 0) return { passed: true };
  return { passed: false, details: violations.join('\n') };
}

/** Helper: check if a statement text is an OTel instrumentation call. */
function isOTelStatement(text: string): boolean {
  return (
    text.includes('recordException') ||
    text.includes('setStatus') ||
    text.includes('SpanStatusCode') ||
    text.startsWith('span.') ||
    text.startsWith('otelSpan.')
  );
}

/** Helper: check if a line is an OTel instrumentation addition. */
function isOTelLine(line: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed.startsWith('span.') ||
    trimmed.startsWith('otelSpan.') ||
    trimmed.includes('recordException') ||
    trimmed.includes('setStatus') ||
    trimmed.includes('SpanStatusCode') ||
    trimmed.includes('startActiveSpan') ||
    trimmed.includes('startSpan') ||
    trimmed.includes('@opentelemetry') ||
    trimmed.includes('trace.getTracer') ||
    trimmed.startsWith('const tracer') ||
    trimmed.startsWith('const otelTracer')
  );
}

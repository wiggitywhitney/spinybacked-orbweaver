// ABOUTME: Validation chain orchestrator — runs Tier 1 then Tier 2 checks.
// ABOUTME: Short-circuits on first Tier 1 failure; skips Tier 2 if Tier 1 fails.

import { checkElision } from './tier1/elision.ts';
import { checkSyntax } from './tier1/syntax.ts';
import { checkLint } from './tier1/lint.ts';
import { checkWeaver } from './tier1/weaver.ts';
import { checkSpansClosed } from './tier2/cdq001.ts';
import { checkNonInstrumentationDiff } from './tier2/nds003.ts';
import { checkOutboundCallSpans } from './tier2/cov002.ts';
import { checkUtilityFunctionSpans } from './tier2/rst001.ts';
import { checkDomainAttributes } from './tier2/cov005.ts';
import type { RegistrySpanDefinition } from './tier2/cov005.ts';
import type { CheckResult, ValidateFileInput, ValidationResult } from './types.ts';

/**
 * Run the full validation chain (Tier 1 + Tier 2) on instrumented output.
 *
 * Tier 1 runs first with short-circuit semantics: if any check fails,
 * subsequent Tier 1 checks and all Tier 2 checks are skipped.
 * The order is: elision → syntax → lint → Weaver.
 *
 * Tier 2 runs only after all Tier 1 checks pass. Individual Tier 2 checks
 * are controlled by config.tier2Checks (enabled/blocking per rule).
 *
 * @param input - Validation input with original code, instrumented code, file path, and config
 * @returns Aggregated ValidationResult with results from both tiers
 */
export async function validateFile(input: ValidateFileInput): Promise<ValidationResult> {
  const { originalCode, instrumentedCode, filePath, config } = input;
  const tier1Results: CheckResult[] = [];
  const tier2Results: CheckResult[] = [];

  // --- Tier 1: Structural checks (short-circuit on first failure) ---

  // 1. Elision detection
  const elisionResult = checkElision(instrumentedCode, originalCode, filePath);
  tier1Results.push(elisionResult);
  if (!elisionResult.passed) {
    return buildResult(tier1Results, tier2Results);
  }

  // 2. Syntax checking (file must already be written to disk by caller)
  const syntaxResult = checkSyntax(filePath);
  tier1Results.push(syntaxResult);
  if (!syntaxResult.passed) {
    return buildResult(tier1Results, tier2Results);
  }

  // 3. Lint checking (diff-based)
  const lintResult = await checkLint(originalCode, instrumentedCode, filePath);
  tier1Results.push(lintResult);
  if (!lintResult.passed) {
    return buildResult(tier1Results, tier2Results);
  }

  // 4. Weaver registry check (optional)
  if (config.enableWeaver) {
    const weaverResult = checkWeaver(filePath, config.registryPath);
    tier1Results.push(weaverResult);
    if (!weaverResult.passed) {
      return buildResult(tier1Results, tier2Results);
    }
  }

  // --- Tier 2: Semantic checks (all Tier 1 passed) ---

  if (config.tier2Checks['CDQ-001']?.enabled) {
    const cdq001 = checkSpansClosed(instrumentedCode, filePath);
    cdq001.blocking = config.tier2Checks['CDQ-001'].blocking;
    tier2Results.push(cdq001);
  }

  if (config.tier2Checks['NDS-003']?.enabled) {
    const nds003 = checkNonInstrumentationDiff(originalCode, instrumentedCode, filePath);
    nds003.blocking = config.tier2Checks['NDS-003'].blocking;
    tier2Results.push(nds003);
  }

  if (config.tier2Checks['COV-002']?.enabled) {
    const cov002 = checkOutboundCallSpans(instrumentedCode, filePath);
    cov002.blocking = config.tier2Checks['COV-002'].blocking;
    tier2Results.push(cov002);
  }

  if (config.tier2Checks['RST-001']?.enabled) {
    const rst001 = checkUtilityFunctionSpans(instrumentedCode, filePath);
    rst001.blocking = config.tier2Checks['RST-001'].blocking;
    tier2Results.push(rst001);
  }

  if (config.tier2Checks['COV-005']?.enabled) {
    const registry: RegistrySpanDefinition[] = config.registryDefinitions ?? [];
    const cov005 = checkDomainAttributes(instrumentedCode, filePath, registry);
    cov005.blocking = config.tier2Checks['COV-005'].blocking;
    tier2Results.push(cov005);
  }

  return buildResult(tier1Results, tier2Results);
}

/**
 * Build a ValidationResult from tier1 and tier2 check results.
 */
function buildResult(
  tier1Results: CheckResult[],
  tier2Results: CheckResult[],
): ValidationResult {
  const allResults = [...tier1Results, ...tier2Results];
  const blockingFailures = allResults.filter((r) => !r.passed && r.blocking);
  const advisoryFindings = tier2Results.filter((r) => !r.passed && !r.blocking);

  return {
    passed: blockingFailures.length === 0,
    tier1Results,
    tier2Results,
    blockingFailures,
    advisoryFindings,
  };
}

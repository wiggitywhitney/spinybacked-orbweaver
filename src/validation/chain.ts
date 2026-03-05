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
import { checkEntryPointSpans } from './tier2/cov001.ts';
import { checkErrorVisibility } from './tier2/cov003.ts';
import { checkAsyncOperationSpans } from './tier2/cov004.ts';
import { checkAutoInstrumentationPreference } from './tier2/cov006.ts';
import { checkTrivialAccessorSpans } from './tier2/rst002.ts';
import { checkThinWrapperSpans } from './tier2/rst003.ts';
import { checkInternalDetailSpans } from './tier2/rst004.ts';
import { checkIsRecordingGuard } from './tier2/cdq006.ts';
import { checkSpanNamesMatchRegistry } from './tier2/sch001.ts';
import { checkAttributeKeysMatchRegistry } from './tier2/sch002.ts';
import { checkAttributeValuesConformToTypes } from './tier2/sch003.ts';
import { checkNoRedundantSchemaEntries } from './tier2/sch004.ts';
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

  if (config.tier2Checks['COV-001']?.enabled) {
    const cov001 = checkEntryPointSpans(instrumentedCode, filePath);
    cov001.blocking = config.tier2Checks['COV-001'].blocking;
    tier2Results.push(cov001);
  }

  if (config.tier2Checks['COV-003']?.enabled) {
    const cov003 = checkErrorVisibility(instrumentedCode, filePath);
    cov003.blocking = config.tier2Checks['COV-003'].blocking;
    tier2Results.push(cov003);
  }

  if (config.tier2Checks['COV-004']?.enabled) {
    const cov004 = checkAsyncOperationSpans(instrumentedCode, filePath);
    cov004.blocking = config.tier2Checks['COV-004'].blocking;
    tier2Results.push(cov004);
  }

  if (config.tier2Checks['COV-006']?.enabled) {
    const cov006 = checkAutoInstrumentationPreference(instrumentedCode, filePath);
    cov006.blocking = config.tier2Checks['COV-006'].blocking;
    tier2Results.push(cov006);
  }

  if (config.tier2Checks['RST-002']?.enabled) {
    const rst002 = checkTrivialAccessorSpans(instrumentedCode, filePath);
    rst002.blocking = config.tier2Checks['RST-002'].blocking;
    tier2Results.push(rst002);
  }

  if (config.tier2Checks['RST-003']?.enabled) {
    const rst003 = checkThinWrapperSpans(instrumentedCode, filePath);
    rst003.blocking = config.tier2Checks['RST-003'].blocking;
    tier2Results.push(rst003);
  }

  if (config.tier2Checks['RST-004']?.enabled) {
    const rst004 = checkInternalDetailSpans(instrumentedCode, filePath);
    rst004.blocking = config.tier2Checks['RST-004'].blocking;
    tier2Results.push(rst004);
  }

  if (config.tier2Checks['CDQ-006']?.enabled) {
    const cdq006 = checkIsRecordingGuard(instrumentedCode, filePath);
    cdq006.blocking = config.tier2Checks['CDQ-006'].blocking;
    tier2Results.push(cdq006);
  }

  if (config.tier2Checks['SCH-001']?.enabled && config.resolvedSchema) {
    const sch001 = checkSpanNamesMatchRegistry(instrumentedCode, filePath, config.resolvedSchema);
    sch001.blocking = config.tier2Checks['SCH-001'].blocking;
    tier2Results.push(sch001);
  }

  if (config.tier2Checks['SCH-002']?.enabled && config.resolvedSchema) {
    const sch002 = checkAttributeKeysMatchRegistry(instrumentedCode, filePath, config.resolvedSchema);
    sch002.blocking = config.tier2Checks['SCH-002'].blocking;
    tier2Results.push(sch002);
  }

  if (config.tier2Checks['SCH-003']?.enabled && config.resolvedSchema) {
    const sch003 = checkAttributeValuesConformToTypes(instrumentedCode, filePath, config.resolvedSchema);
    sch003.blocking = config.tier2Checks['SCH-003'].blocking;
    tier2Results.push(sch003);
  }

  if (config.tier2Checks['SCH-004']?.enabled && config.resolvedSchema) {
    const sch004 = checkNoRedundantSchemaEntries(instrumentedCode, filePath, config.resolvedSchema);
    sch004.blocking = config.tier2Checks['SCH-004'].blocking;
    tier2Results.push(sch004);
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

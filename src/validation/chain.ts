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
import { checkForbiddenImports } from './tier2/api001.ts';
import { checkOtelApiDependencyPlacement } from './tier2/api002.ts';
import { checkModuleSystemMatch } from './tier2/nds006.ts';
import { checkExportedSignaturePreservation } from './tier2/nds004.ts';
import { checkControlFlowPreservation } from './tier2/nds005.ts';
import { checkDoubleInstrumentation } from './tier2/rst005.ts';
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
    tier2Results.push(...collectCheckResults(
      checkSpansClosed(instrumentedCode, filePath),
      config.tier2Checks['CDQ-001'].blocking,
    ));
  }

  if (config.tier2Checks['NDS-003']?.enabled) {
    tier2Results.push(...collectCheckResults(
      checkNonInstrumentationDiff(originalCode, instrumentedCode, filePath),
      config.tier2Checks['NDS-003'].blocking,
    ));
  }

  if (config.tier2Checks['COV-002']?.enabled) {
    tier2Results.push(...collectCheckResults(
      checkOutboundCallSpans(instrumentedCode, filePath),
      config.tier2Checks['COV-002'].blocking,
    ));
  }

  if (config.tier2Checks['RST-001']?.enabled) {
    tier2Results.push(...collectCheckResults(
      checkUtilityFunctionSpans(instrumentedCode, filePath),
      config.tier2Checks['RST-001'].blocking,
    ));
  }

  if (config.tier2Checks['COV-005']?.enabled) {
    const registry: RegistrySpanDefinition[] = config.registryDefinitions ?? [];
    tier2Results.push(...collectCheckResults(
      checkDomainAttributes(instrumentedCode, filePath, registry),
      config.tier2Checks['COV-005'].blocking,
    ));
  }

  if (config.tier2Checks['COV-001']?.enabled) {
    tier2Results.push(...collectCheckResults(
      checkEntryPointSpans(instrumentedCode, filePath),
      config.tier2Checks['COV-001'].blocking,
    ));
  }

  if (config.tier2Checks['COV-003']?.enabled) {
    tier2Results.push(...collectCheckResults(
      checkErrorVisibility(instrumentedCode, filePath),
      config.tier2Checks['COV-003'].blocking,
    ));
  }

  if (config.tier2Checks['COV-004']?.enabled) {
    tier2Results.push(...collectCheckResults(
      checkAsyncOperationSpans(instrumentedCode, filePath),
      config.tier2Checks['COV-004'].blocking,
    ));
  }

  if (config.tier2Checks['COV-006']?.enabled) {
    tier2Results.push(...collectCheckResults(
      checkAutoInstrumentationPreference(instrumentedCode, filePath),
      config.tier2Checks['COV-006'].blocking,
    ));
  }

  if (config.tier2Checks['RST-002']?.enabled) {
    tier2Results.push(...collectCheckResults(
      checkTrivialAccessorSpans(instrumentedCode, filePath),
      config.tier2Checks['RST-002'].blocking,
    ));
  }

  if (config.tier2Checks['RST-003']?.enabled) {
    tier2Results.push(...collectCheckResults(
      checkThinWrapperSpans(instrumentedCode, filePath),
      config.tier2Checks['RST-003'].blocking,
    ));
  }

  if (config.tier2Checks['RST-004']?.enabled) {
    tier2Results.push(...collectCheckResults(
      checkInternalDetailSpans(instrumentedCode, filePath),
      config.tier2Checks['RST-004'].blocking,
    ));
  }

  if (config.tier2Checks['CDQ-006']?.enabled) {
    tier2Results.push(...collectCheckResults(
      checkIsRecordingGuard(instrumentedCode, filePath),
      config.tier2Checks['CDQ-006'].blocking,
    ));
  }

  // API-001/003/004: Forbidden import detection (combined check)
  // A single scan covers all three rules. Results are tagged with the
  // specific ruleId (API-001 for OTel SDK imports, API-003 for vendor SDKs).
  // API-004 (no SDK internal imports) uses the same mechanism as API-001.
  if (config.tier2Checks['API-001']?.enabled) {
    tier2Results.push(...collectCheckResults(
      checkForbiddenImports(instrumentedCode, filePath),
      config.tier2Checks['API-001'].blocking,
    ));
  }

  // API-002: Verify @opentelemetry/api dependency placement (library vs app).
  // Requires projectRoot to read package.json.
  if (config.tier2Checks['API-002']?.enabled && config.projectRoot) {
    tier2Results.push(...collectCheckResults(
      checkOtelApiDependencyPlacement(filePath, config.projectRoot),
      config.tier2Checks['API-002'].blocking,
    ));
  }

  // NDS-006: Verify instrumented code uses the same module system as the original.
  if (config.tier2Checks['NDS-006']?.enabled) {
    tier2Results.push(...collectCheckResults(
      checkModuleSystemMatch(originalCode, instrumentedCode, filePath),
      config.tier2Checks['NDS-006'].blocking,
    ));
  }

  // NDS-004: Verify exported function signatures are preserved after instrumentation.
  if (config.tier2Checks['NDS-004']?.enabled) {
    tier2Results.push(...collectCheckResults(
      checkExportedSignaturePreservation(originalCode, instrumentedCode, filePath),
      config.tier2Checks['NDS-004'].blocking,
    ));
  }

  // NDS-005: Verify existing try/catch/finally structure is preserved after instrumentation.
  if (config.tier2Checks['NDS-005']?.enabled) {
    tier2Results.push(...collectCheckResults(
      checkControlFlowPreservation(originalCode, instrumentedCode, filePath),
      config.tier2Checks['NDS-005'].blocking,
    ));
  }

  // RST-005: Detect double-instrumentation — spans added to already-instrumented functions.
  if (config.tier2Checks['RST-005']?.enabled) {
    tier2Results.push(...collectCheckResults(
      checkDoubleInstrumentation(originalCode, instrumentedCode, filePath),
      config.tier2Checks['RST-005'].blocking,
    ));
  }

  if (config.tier2Checks['SCH-001']?.enabled && config.resolvedSchema) {
    tier2Results.push(...collectCheckResults(
      checkSpanNamesMatchRegistry(instrumentedCode, filePath, config.resolvedSchema),
      config.tier2Checks['SCH-001'].blocking,
    ));
  }

  if (config.tier2Checks['SCH-002']?.enabled && config.resolvedSchema) {
    tier2Results.push(...collectCheckResults(
      checkAttributeKeysMatchRegistry(instrumentedCode, filePath, config.resolvedSchema),
      config.tier2Checks['SCH-002'].blocking,
    ));
  }

  if (config.tier2Checks['SCH-003']?.enabled && config.resolvedSchema) {
    tier2Results.push(...collectCheckResults(
      checkAttributeValuesConformToTypes(instrumentedCode, filePath, config.resolvedSchema),
      config.tier2Checks['SCH-003'].blocking,
    ));
  }

  if (config.tier2Checks['SCH-004']?.enabled && config.resolvedSchema) {
    tier2Results.push(...collectCheckResults(
      checkNoRedundantSchemaEntries(instrumentedCode, filePath, config.resolvedSchema),
      config.tier2Checks['SCH-004'].blocking,
    ));
  }

  return buildResult(tier1Results, tier2Results);
}

/**
 * Normalize a check result (single or array) and apply the blocking flag
 * from the validation config. Supports the migration from single-result
 * checks to per-finding array results (issue #43).
 */
export function collectCheckResults(
  result: CheckResult | CheckResult[],
  blocking: boolean,
): CheckResult[] {
  const results = Array.isArray(result) ? result : [result];
  return results.map((r) => ({ ...r, blocking }));
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

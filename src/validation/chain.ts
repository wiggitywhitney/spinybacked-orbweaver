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
  const judgeTokenUsage: import('../agent/schema.ts').TokenUsage[] = [];

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
  // specific ruleId. Per-rule config lookup ensures each can be toggled independently.
  const apiImportChecksEnabled =
    config.tier2Checks['API-001']?.enabled ||
    config.tier2Checks['API-003']?.enabled ||
    config.tier2Checks['API-004']?.enabled;

  if (apiImportChecksEnabled) {
    for (const result of checkForbiddenImports(instrumentedCode, filePath)) {
      const ruleConfig = config.tier2Checks[result.ruleId];
      if (!ruleConfig?.enabled) continue;
      tier2Results.push(...collectCheckResults([result], ruleConfig.blocking));
    }
  }

  // API-002: Verify @opentelemetry/api dependency placement (library vs app).
  // Requires projectRoot to read package.json.
  if (config.tier2Checks['API-002']?.enabled) {
    if (config.projectRoot) {
      tier2Results.push(...collectCheckResults(
        checkOtelApiDependencyPlacement(filePath, config.projectRoot),
        config.tier2Checks['API-002'].blocking,
      ));
    } else {
      tier2Results.push({
        ruleId: 'API-002',
        passed: true,
        filePath,
        lineNumber: null,
        message: 'API-002: Skipped — projectRoot not configured, cannot read package.json.',
        tier: 2,
        blocking: false,
      });
    }
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
    const judgeDeps = config.anthropicClient
      ? { client: config.anthropicClient }
      : undefined;
    const nds005 = await checkControlFlowPreservation(
      originalCode,
      instrumentedCode,
      filePath,
      judgeDeps,
    );
    tier2Results.push(...collectCheckResults(
      nds005.results,
      config.tier2Checks['NDS-005'].blocking,
    ));
    if (nds005.judgeTokenUsage.length > 0) {
      judgeTokenUsage.push(...nds005.judgeTokenUsage);
    }
  }

  // RST-005: Detect double-instrumentation — spans added to already-instrumented functions.
  if (config.tier2Checks['RST-005']?.enabled) {
    tier2Results.push(...collectCheckResults(
      checkDoubleInstrumentation(originalCode, instrumentedCode, filePath),
      config.tier2Checks['RST-005'].blocking,
    ));
  }

  if (config.tier2Checks['SCH-001']?.enabled && config.resolvedSchema) {
    const judgeDeps = config.anthropicClient
      ? { client: config.anthropicClient }
      : undefined;
    const sch001 = await checkSpanNamesMatchRegistry(
      instrumentedCode,
      filePath,
      config.resolvedSchema,
      judgeDeps,
      config.declaredSpanExtensions,
    );
    tier2Results.push(...collectCheckResults(
      sch001.results,
      config.tier2Checks['SCH-001'].blocking,
    ));
    if (sch001.judgeTokenUsage.length > 0) {
      judgeTokenUsage.push(...sch001.judgeTokenUsage);
    }
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
    const judgeDeps = config.anthropicClient
      ? { client: config.anthropicClient }
      : undefined;
    const sch004 = await checkNoRedundantSchemaEntries(
      instrumentedCode,
      filePath,
      config.resolvedSchema,
      judgeDeps,
    );
    tier2Results.push(...collectCheckResults(
      sch004.results,
      config.tier2Checks['SCH-004'].blocking,
    ));
    if (sch004.judgeTokenUsage.length > 0) {
      judgeTokenUsage.push(...sch004.judgeTokenUsage);
    }
  }

  return buildResult(tier1Results, tier2Results, judgeTokenUsage);
}

/**
 * Normalize a check result (single or array) and apply the blocking flag
 * from the validation config. Supports the migration from single-result
 * checks to per-finding array results (issue #43).
 *
 * Per-finding blocking decisions are preserved: a finding that sets
 * blocking: false (e.g., low-confidence judge verdict) stays advisory
 * even if the rule-level config says blocking: true. The conjunction
 * ensures a finding can only block if BOTH the config allows it AND
 * the individual finding says it should.
 */
export function collectCheckResults(
  result: CheckResult | CheckResult[],
  blocking: boolean,
): CheckResult[] {
  const results = Array.isArray(result) ? result : [result];
  return results.map((r) => ({ ...r, blocking: r.blocking && blocking }));
}

/**
 * Build a ValidationResult from tier1 and tier2 check results.
 */
function buildResult(
  tier1Results: CheckResult[],
  tier2Results: CheckResult[],
  judgeTokenUsage?: import('../agent/schema.ts').TokenUsage[],
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
    ...(judgeTokenUsage && judgeTokenUsage.length > 0 ? { judgeTokenUsage } : {}),
  };
}

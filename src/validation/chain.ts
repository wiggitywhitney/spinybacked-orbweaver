// ABOUTME: Validation chain orchestrator — runs Tier 1 then Tier 2 checks.
// ABOUTME: Short-circuits on first Tier 1 failure; skips Tier 2 if Tier 1 fails.

import { checkElision } from './tier1/elision.ts';
import { checkWeaver } from './tier1/weaver.ts';
import { JavaScriptProvider } from '../languages/javascript/index.ts';
import { getRulesForLanguage } from './rule-registry.ts';
import type { RuleInput, RuleCheckResult } from '../languages/types.ts';
import type { TokenUsage } from '../agent/schema.ts';
import type { CheckResult, ValidateFileInput, ValidationResult } from './types.ts';

/** Default provider used when no provider is passed in ValidateFileInput. */
const DEFAULT_PROVIDER = new JavaScriptProvider();

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
  const provider = input.provider ?? DEFAULT_PROVIDER;
  const tier1Results: CheckResult[] = [];
  const tier2Results: CheckResult[] = [];
  const judgeTokenUsage: TokenUsage[] = [];

  // --- Tier 1: Structural checks (short-circuit on first failure) ---

  // 1. Elision detection (cross-language — stays in tier1/elision.ts)
  const elisionResult = checkElision(instrumentedCode, originalCode, filePath);
  tier1Results.push(elisionResult);
  if (!elisionResult.passed) {
    return buildResult(tier1Results, tier2Results);
  }

  // 2. Syntax checking — dispatched through provider (file must be written to disk by caller)
  const syntaxResult = await provider.checkSyntax(filePath);
  tier1Results.push(syntaxResult);
  if (!syntaxResult.passed) {
    return buildResult(tier1Results, tier2Results);
  }

  // 3. Lint checking (diff-based) — dispatched through provider
  const lintResult = await provider.lintCheck(originalCode, instrumentedCode);
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
  // Rules are dispatched through the rule registry. JavaScriptProvider registers
  // all JS rules on construction (DEFAULT_PROVIDER above). Each rule's check()
  // method receives a RuleInput that extends ValidateFileInput with language context.

  const ruleInput: RuleInput = { ...input, language: provider.id, provider };
  const applicableRules = getRulesForLanguage(provider.id);

  for (const rule of applicableRules) {
    const ruleConfig = config.tier2Checks[rule.ruleId];
    if (!ruleConfig?.enabled) continue;

    const rawResult = await rule.check(ruleInput);
    const { results, judgeTokenUsage: ruleJudgeUsage } = unpackRuleResult(rawResult);

    tier2Results.push(...collectCheckResults(results, ruleConfig.blocking));
    if (ruleJudgeUsage.length > 0) {
      judgeTokenUsage.push(...ruleJudgeUsage);
    }
  }

  return buildResult(tier1Results, tier2Results, judgeTokenUsage);
}

/**
 * Normalize a RuleCheckResult (single, array, or judge-result object) into
 * a flat results array plus any judge token usage for cost tracking.
 *
 * Three forms supported (see RuleCheckResult in src/languages/types.ts):
 * - CheckResult[]: returned as-is
 * - CheckResult: wrapped in an array
 * - { results, judgeTokenUsage? }: extracted with optional token usage
 */
function unpackRuleResult(raw: RuleCheckResult): {
  results: CheckResult[];
  judgeTokenUsage: TokenUsage[];
} {
  if (Array.isArray(raw)) {
    return { results: raw, judgeTokenUsage: [] };
  }
  if ('results' in raw) {
    const results = Array.isArray(raw.results) ? raw.results : [raw.results];
    return { results, judgeTokenUsage: raw.judgeTokenUsage ?? [] };
  }
  return { results: [raw], judgeTokenUsage: [] };
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
  judgeTokenUsage?: TokenUsage[],
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

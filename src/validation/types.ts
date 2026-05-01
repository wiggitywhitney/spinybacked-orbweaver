// ABOUTME: Shared type definitions for the validation chain.
// ABOUTME: Defines CheckResult, ValidationResult, ValidationConfig, and ValidateFileInput.

import type Anthropic from '@anthropic-ai/sdk';
import type { TokenUsage } from '../agent/schema.ts';

/**
 * Result of a single validation check.
 * Designed for LLM consumption — every field provides actionable information
 * that an agent can use to fix the identified issue.
 */
export interface CheckResult {
  /**
   * Rule identifier matching the scoring checklist spec.
   *
   * Tier 1: "ELISION", "NDS-001" (syntax), "LINT", "WEAVER"
   * Tier 2 — Coverage: "COV-001" through "COV-006"
   * Tier 2 — Quality: "CDQ-001", "CDQ-005", "CDQ-006", "CDQ-007", "CDQ-009", "CDQ-010", "CDQ-011"
   * Tier 2 — Restraint: "RST-001" through "RST-005"
   * Tier 2 — Non-destructive: "NDS-003" through "NDS-006"
   * Tier 2 — API: "API-001" through "API-004"
   * Tier 2 — Schema: "SCH-001" through "SCH-003"
   *
   * Note: NDS-002 (tests still pass) is enforced by the coordinator's
   * schema checkpoint (dispatch.ts), not as a per-file validation check.
   * It runs the project's test suite at checkpoint intervals.
   */
  ruleId: string;
  /** Whether this check passed. */
  passed: boolean;
  /** Path to the file being validated. */
  filePath: string;
  /** Line number where the issue was found, or null for file-level checks. */
  lineNumber: number | null;
  /** Actionable feedback designed for LLM consumption. */
  message: string;
  /** Validation tier: 1 = structural, 2 = semantic. */
  tier: 1 | 2;
  /** Whether failure reverts the file (true) or is advisory (false). */
  blocking: boolean;
}

/**
 * Aggregated result of the full validation chain (Tier 1 + Tier 2).
 */
export interface ValidationResult {
  /** Whether all blocking checks passed. */
  passed: boolean;
  /** Results from Tier 1 structural checks (ELISION, NDS-001, LINT, WEAVER). */
  tier1Results: CheckResult[];
  /** Results from Tier 2 semantic checks (CDQ, COV, RST, NDS, API, SCH dimensions). */
  tier2Results: CheckResult[];
  /** All failed blocking checks from both tiers. */
  blockingFailures: CheckResult[];
  /** All failed advisory checks from Tier 2. */
  advisoryFindings: CheckResult[];
  /** Token usage from LLM judge calls (SCH-001, SCH-002). Tracked separately from instrumentation costs. */
  judgeTokenUsage?: TokenUsage[];
}

/**
 * Registry definition for a single span — what attributes it should have.
 * Populated from the Weaver telemetry registry for COV-005 domain attribute checks.
 */
export interface RegistrySpanDefinition {
  spanName: string;
  requiredAttributes: string[];
  recommendedAttributes: string[];
}

/**
 * Controls which checks run and their blocking/advisory classification.
 * Phase 2 defines the shape; Phase 4+ extends with additional Tier 2 rules.
 */
export interface ValidationConfig {
  /** Whether to run the Weaver registry check. False when no schema exists. */
  enableWeaver: boolean;
  /** Per-rule configuration for Tier 2 checks, keyed by rule ID. */
  tier2Checks: Record<
    string,
    {
      enabled: boolean;
      /** Whether failure reverts the file (true) or is advisory (false). */
      blocking: boolean;
    }
  >;
  /** Weaver registry directory. Required if enableWeaver is true. */
  registryPath?: string;
  /** Registry span definitions for COV-005 domain attribute checks. */
  registryDefinitions?: RegistrySpanDefinition[];
  /** Resolved Weaver registry (from `weaver registry resolve -f json`).
   *  Used by SCH-001 through SCH-003 Tier 2 checks. */
  resolvedSchema?: object;
  /** Absolute path to project root. Required for API-002 dependency placement check. */
  projectRoot?: string;
  /** Anthropic client for LLM judge calls. When provided, semi-automatable rules use judge for semantic evaluation. */
  anthropicClient?: Anthropic;
  /** Agent-declared schema extensions for the current file. SCH-001 accepts span names
   *  matching these extensions in addition to registry definitions. Format: `span.<namespace>.<operation>`. */
  declaredSpanExtensions?: string[];
  /** Canonical tracer name resolved by the coordinator. When set, CDQ-011 verifies all
   *  trace.getTracer() string literals match this name exactly. */
  canonicalTracerName?: string;
}

/**
 * Input to the validation chain's validateFile function.
 * Uses an options object to avoid positional parameter confusion.
 */
export interface ValidateFileInput {
  /** Original file content before instrumentation (for diff-based lint and NDS-003). */
  originalCode: string;
  /** Agent's instrumented output. */
  instrumentedCode: string;
  /** File path on disk for filesystem-based checks (syntax, lint). */
  filePath: string;
  /** Which checks to enable and their blocking/advisory classification. */
  config: ValidationConfig;
  /**
   * Language provider for this file.
   *
   * Tier 1 checks (syntax, lint, format) are dispatched through the provider.
   * Required — callers must supply a provider explicitly. Failing to do so
   * reflects a programming error (silently defaulting to JavaScript is how
   * multi-language support breaks).
   *
   * Type-only import avoids a circular runtime dependency between validation and
   * languages modules (both depend on each other for types only).
   */
  provider: import('../languages/types.ts').LanguageProvider;
}

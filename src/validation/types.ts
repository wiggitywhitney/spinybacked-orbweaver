// ABOUTME: Shared type definitions for the validation chain.
// ABOUTME: Defines CheckResult, ValidationResult, ValidationConfig, and ValidateFileInput.

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
   * Tier 2 — Quality: "CDQ-001", "CDQ-006", "CDQ-008"
   * Tier 2 — Restraint: "RST-001" through "RST-005"
   * Tier 2 — Non-destructive: "NDS-003" through "NDS-006"
   * Tier 2 — API: "API-001" through "API-004"
   * Tier 2 — Schema: "SCH-001" through "SCH-004"
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
  registryDefinitions?: import('./tier2/cov005.ts').RegistrySpanDefinition[];
  /** Resolved Weaver registry (from `weaver registry resolve -f json`).
   *  Used by SCH-001 through SCH-004 Tier 2 checks. */
  resolvedSchema?: object;
  /** Absolute path to project root. Required for API-002 dependency placement check. */
  projectRoot?: string;
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
}

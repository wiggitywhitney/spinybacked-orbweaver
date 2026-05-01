// ABOUTME: Human-readable display names for validation rule IDs.
// ABOUTME: Used in error summaries, CLI output, PR summaries, and diagnostics.

/**
 * Map validation rule IDs to human-readable display names.
 * Used wherever rule IDs appear in user-facing output.
 */
const RULE_NAMES: Record<string, string> = {
  // Tier 1 — Structural
  'ELISION': 'Elision Detected',
  'NDS-001': 'Syntax Valid',
  'LINT': 'Lint Clean',
  'WEAVER': 'Schema Valid',

  // Tier 2 — Coverage
  'COV-001': 'Entry Point Spans',
  'COV-002': 'Outbound Call Spans',
  'COV-003': 'Error Recording',
  'COV-004': 'Async Operation Spans',
  'COV-005': 'Domain Attributes',
  'COV-006': 'Auto-Instrumentation Preference',

  // Tier 2 — Quality
  'CDQ-001': 'Spans Closed',
  'CDQ-005': 'startActiveSpan Preferred',
  'CDQ-006': 'isRecording Guard',
  'CDQ-007': 'Attribute Data Quality',
  'CDQ-009': 'Null-Safe Guard',
  'CDQ-010': 'String Method Type Safety',
  'CDQ-011': 'Canonical Tracer Name',

  // Tier 2 — Restraint
  'RST-001': 'No Utility Spans',
  'RST-002': 'No Trivial Accessor Spans',
  'RST-003': 'No Thin Wrapper Spans',
  'RST-004': 'No Internal Detail Spans',
  'RST-005': 'No Double Instrumentation',
  'RST-006': 'No Spans on process.exit() Functions',

  // Tier 2 — Non-destructive
  'NDS-003': 'Code Preserved',
  'NDS-004': 'Signatures Preserved',
  'NDS-005': 'Control Flow Preserved',
  'NDS-006': 'Module System Match',
  'NDS-007': 'Expected Catch Unmodified',

  // Tier 2 — API (API-003 deleted in the advisory rules audit)
  'API-001': 'OTel API Only',
  'API-002': 'Dependency Placement',
  'API-004': 'SDK Package Placement',

  // Tier 2 — Schema
  'SCH-001': 'Span Names Match Registry',
  'SCH-002': 'Attribute Keys Match Registry',
  'SCH-003': 'Attribute Values Conform',
  'SCH-005': 'No Duplicate Span Definitions',
};

/**
 * Get the human-readable name for a rule ID.
 * Returns the rule ID unchanged if no name is registered.
 *
 * @param ruleId - Validation rule identifier (e.g. "SCH-002")
 * @returns Human-readable name (e.g. "Attribute Keys Match Registry") or the original ruleId
 */
export function getRuleName(ruleId: string): string {
  return RULE_NAMES[ruleId] ?? ruleId;
}

/**
 * Format a rule ID with its human-readable name for display.
 * Produces "SCH-002 (Attribute Keys Match Registry)" format.
 *
 * @param ruleId - Validation rule identifier
 * @returns Formatted string with both code and name
 */
export function formatRuleId(ruleId: string): string {
  const name = RULE_NAMES[ruleId];
  return name ? `${ruleId} (${name})` : ruleId;
}

/**
 * Expand bare rule codes in free text to include human-readable labels.
 * Transforms "skipped per RST-001" to "skipped per RST-001 (No Utility Spans)".
 * Skips codes that are already expanded (followed by " (").
 *
 * @param text - Free text that may contain bare rule codes
 * @returns Text with known rule codes expanded to include labels
 */
export function expandRuleCodesInText(text: string): string {
  // Match rule codes (e.g., RST-001, NDS-005b) NOT already followed by " ("
  return text.replace(/\b([A-Z]{2,4}-\d{3}[a-z]?)\b(?! \()/g, (match) => {
    const name = RULE_NAMES[match];
    return name ? `${match} (${name})` : match;
  });
}

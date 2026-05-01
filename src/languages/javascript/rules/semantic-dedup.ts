// ABOUTME: Shared semantic duplicate detection for SCH-001 and SCH-002 extension acceptance paths.
// ABOUTME: Three-stage pipeline: normalization comparison → Jaccard pre-pass → optional LLM judge.

import type Anthropic from '@anthropic-ai/sdk';
import type { TokenUsage } from '../../../agent/schema.ts';
import { callJudge } from '../../../validation/judge.ts';
import type { JudgeOptions } from '../../../validation/judge.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Inferred value type of a span.setAttribute value, used for type-compatibility pre-filtering. */
export type InferredType = 'string' | 'int' | 'double' | 'boolean' | 'unknown';

/** A registry entry to compare a candidate against. */
export interface RegistryEntry {
  /** Attribute key or span operation name. */
  name: string;
  /** Normalized type string for type-compatibility pre-filter (SCH-002 only). Omit for span names. */
  type?: string;
}

/** Optional judge dependencies. When absent, only normalization (and Jaccard) run. */
export interface SemanticDedupDeps {
  client: Anthropic;
  options?: JudgeOptions;
}

/** Options controlling which pipeline stages run. */
export interface SemanticDedupOptions {
  /** Rule ID forwarded to judge calls for attribution (e.g., 'SCH-001'). */
  ruleId: string;
  /**
   * Whether to run the Jaccard pre-pass stage.
   * True for attribute keys (SCH-002), false for span names (SCH-001).
   * Span names are too short for Jaccard to add value.
   */
  useJaccard: boolean;
  /**
   * Inferred value type of the candidate expression, for type-compatibility pre-filtering.
   * When provided, enables both the type-compat and namespace pre-filters before the judge call.
   * Omit for SCH-001 (span names have no type or namespace pre-filtering).
   */
  inferredType?: InferredType;
  /** LLM judge dependencies. When absent, only normalization and Jaccard run. */
  judgeDeps?: SemanticDedupDeps;
}

/** Result of semantic duplicate detection. */
export interface SemanticDedupResult {
  isDuplicate: boolean;
  /** The registry entry that matched, when isDuplicate is true. */
  matchedEntry?: string;
  /** Which pipeline stage detected the duplicate. */
  detectionMethod?: 'normalization' | 'jaccard' | 'judge';
  /** Token usage from judge calls (empty when judge was not invoked). */
  judgeTokenUsage: TokenUsage[];
}

// ---------------------------------------------------------------------------
// Exported helpers (unit-testable)
// ---------------------------------------------------------------------------

/**
 * Normalize a name for delimiter-variant comparison.
 * Strips '.', '-', '_' and lowercases.
 * "http_request_duration" and "http.request.duration" both normalize to "httprequestduration".
 */
export function normalizeKey(s: string): string {
  return s.toLowerCase().replace(/[._-]/g, '');
}

/**
 * Tokenize a name by splitting on delimiter characters.
 * "http.request.duration" → { "http", "request", "duration" }
 */
function tokenize(s: string): Set<string> {
  return new Set(
    s.toLowerCase().split(/[._-]/).filter((t) => t.length > 0),
  );
}

/**
 * Compute Jaccard token similarity between two names.
 * Returns |A ∩ B| / |A ∪ B|, where A and B are token sets.
 * Empty inputs both return 0.
 */
export function computeJaccardSimilarity(a: string, b: string): number {
  const tokA = tokenize(a);
  const tokB = tokenize(b);
  if (tokA.size === 0 && tokB.size === 0) return 0;

  let intersection = 0;
  for (const t of tokA) {
    if (tokB.has(t)) intersection++;
  }
  const union = tokA.size + tokB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Check whether an inferred value type is compatible with a registry attribute type.
 * 'unknown' is always compatible (cannot determine type → don't pre-filter).
 * int and double are mutually compatible (both numeric).
 */
export function isTypeCompatible(novelType: InferredType, registryType?: string): boolean {
  if (novelType === 'unknown') return true;
  if (!registryType) return true;

  // Numeric types are compatible with each other
  if (
    (novelType === 'int' || novelType === 'double') &&
    (registryType === 'int' || registryType === 'double')
  ) {
    return true;
  }

  return novelType === registryType;
}

// ---------------------------------------------------------------------------
// Main orchestration
// ---------------------------------------------------------------------------

/**
 * Check whether a candidate extension name is a semantic duplicate of any registry entry.
 *
 * When options.inferredType is provided, type-compatible entries are selected first.
 * This pre-filter applies before all three pipeline stages to prevent type-mismatched registry
 * entries from triggering false positives at any stage (including Jaccard, which has no type
 * awareness on its own). For example: a string attribute "user_age_label" should not be
 * flagged as a Jaccard duplicate of an int attribute "user.age" even though their token
 * overlap is 0.67. SCH-001 never provides inferredType (span names have no value type).
 *
 * Three-stage pipeline (all stages operate on the type-filtered entry set):
 * 1. Normalization: strip delimiters, lowercase, compare — catches delimiter-variant duplicates.
 * 2. Jaccard pre-pass (if options.useJaccard): token similarity > 0.5 — catches structural
 *    near-duplicates. Threshold of 0.5 means more than half the tokens overlap; this catches
 *    obvious delimiter-style variants before paying for a judge call while avoiding false
 *    positives on pairs that share only a single common token.
 * 3. LLM judge (if options.judgeDeps): semantic equivalence with namespace pre-filter applied
 *    when candidate has dots (restricts to same root namespace — cross-domain pairs like
 *    "commit_story.*" vs "gen_ai.*" are never semantic duplicates).
 *    SCH-001 passes all entries without namespace pre-filtering (span names are short).
 *
 * @param candidate - The extension name being declared (e.g., "user_registration" or "http_request_duration").
 * @param registryEntries - Existing registry entries to compare against.
 * @param options - Controls which pipeline stages run.
 */
export async function checkSemanticDuplicate(
  candidate: string,
  registryEntries: RegistryEntry[],
  options: SemanticDedupOptions,
): Promise<SemanticDedupResult> {
  const noMatch: SemanticDedupResult = { isDuplicate: false, judgeTokenUsage: [] };

  if (registryEntries.length === 0) return noMatch;

  // Type-compatibility pre-filter: when inferredType is provided, restrict all pipeline stages
  // to registry entries whose type is compatible with the candidate's value type.
  // 'unknown' type is always compatible (cannot determine type → don't pre-filter).
  // Applies before normalization and Jaccard as well as the judge, so a string candidate
  // is never flagged as a duplicate of an int registry entry at any stage.
  const activeEntries = options.inferredType !== undefined
    ? registryEntries.filter((e) => isTypeCompatible(options.inferredType!, e.type))
    : registryEntries;

  if (activeEntries.length === 0) return noMatch;

  // Stage 1: Normalization comparison (always runs)
  const normalizedCandidate = normalizeKey(candidate);
  for (const entry of activeEntries) {
    if (normalizedCandidate === normalizeKey(entry.name)) {
      return {
        isDuplicate: true,
        matchedEntry: entry.name,
        detectionMethod: 'normalization',
        judgeTokenUsage: [],
      };
    }
  }

  // Stage 2: Jaccard pre-pass (attribute keys only — useJaccard: true)
  // Threshold > 0.5: more than half the tokens must overlap. Catches delimiter-style structural
  // near-duplicates (e.g., "http.request.status_code" vs "http.response.status_code") cheaply
  // before paying for a judge call.
  if (options.useJaccard) {
    for (const entry of activeEntries) {
      if (computeJaccardSimilarity(candidate, entry.name) > 0.5) {
        return {
          isDuplicate: true,
          matchedEntry: entry.name,
          detectionMethod: 'jaccard',
          judgeTokenUsage: [],
        };
      }
    }
  }

  // Stage 3: LLM judge (optional — requires judgeDeps)
  if (!options.judgeDeps) return noMatch;

  // Namespace pre-filter for judge: restrict to the same root namespace when candidate has dots.
  // A "commit_story.*" attribute is never a semantic duplicate of a "gen_ai.*" attribute.
  // SCH-001 span names are short and need no namespace pre-filtering.
  let candidates = activeEntries;

  if (options.inferredType !== undefined) {
    // Namespace pre-filter: restrict to the same root namespace when candidate has dots.
    // A "commit_story.*" attribute is never a semantic duplicate of a "gen_ai.*" attribute.
    const candidateRoot = candidate.includes('.') ? (candidate.split('.')[0] ?? '') : '';
    if (candidateRoot) {
      candidates = candidates.filter((e) => {
        const entryRoot = e.name.split('.')[0] ?? '';
        return entryRoot === candidateRoot;
      });
    }
  }

  if (candidates.length === 0) return noMatch;

  const candidateNames = candidates.map((e) => e.name);
  const judgeResult = await callJudge(
    {
      ruleId: options.ruleId,
      context: `"${candidate}" is being declared as a new schema extension.`,
      question:
        `Is "${candidate}" semantically distinct from all listed registry entries? ` +
        `Answer true if it captures a concept not already represented in the registry. ` +
        `Answer false if it is a semantic duplicate of an existing entry — and if so, which entry should be used instead?`,
      candidates: candidateNames,
    },
    options.judgeDeps.client,
    options.judgeDeps.options,
  );

  if (!judgeResult) return noMatch;

  const judgeTokenUsage: TokenUsage[] = [judgeResult.tokenUsage];

  if (!judgeResult.verdict) return { ...noMatch, judgeTokenUsage };

  if (!judgeResult.verdict.answer && judgeResult.verdict.confidence >= 0.7) {
    // Use the judge's suggestion if parseable; fall back to the first filtered candidate.
    // candidateNames is guaranteed non-empty (checked above); candidate is never needed as fallback.
    const matchedEntry =
      extractNameFromSuggestion(judgeResult.verdict.suggestion ?? '', candidateNames) ??
      candidateNames[0]!;
    return {
      isDuplicate: true,
      matchedEntry,
      detectionMethod: 'judge',
      judgeTokenUsage,
    };
  }

  return { ...noMatch, judgeTokenUsage };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Extract a registry entry name from a judge suggestion string.
 * Looks for a quoted dotted-identifier that matches one of the candidates.
 * Returns undefined when no match is found.
 */
function extractNameFromSuggestion(suggestion: string, candidates: string[]): string | undefined {
  const match = suggestion.match(/["']([a-z][a-z0-9._-]*)["']/);
  const extracted = match?.[1];
  if (extracted && candidates.includes(extracted)) return extracted;
  return undefined;
}

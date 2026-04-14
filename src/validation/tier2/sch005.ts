// ABOUTME: SCH-005 Tier 2 check — no duplicate span definitions in the registry.
// ABOUTME: Flags semantically equivalent span definitions using Jaccard similarity + LLM judge.

import type Anthropic from '@anthropic-ai/sdk';
import type { CheckResult } from '../types.ts';
import type { TokenUsage } from '../../agent/schema.ts';
import { callJudge } from '../judge.ts';
import type { JudgeOptions } from '../judge.ts';
import { parseResolvedRegistry, getSpanDefinitions } from './registry-types.ts';
import type { ValidationRule } from '../../languages/types.ts';

/**
 * A span definition extracted from the resolved registry.
 */
export interface SpanDefinition {
  /** Span ID (e.g. "span.myapp.api.handle_request"). */
  id: string;
  /** Human-readable description, when present in the registry. */
  brief?: string;
}

/**
 * Optional judge dependencies for semantic equivalence detection.
 * Mirrors the shape used in SCH-004.
 */
export interface Sch005JudgeDeps {
  client: Anthropic;
  options?: JudgeOptions;
}

/**
 * Result of SCH-005 check including judge token usage for cost tracking.
 */
export interface Sch005Result {
  results: CheckResult[];
  judgeTokenUsage: TokenUsage[];
}

/**
 * Extract all span definitions from the resolved registry.
 *
 * Uses `parseResolvedRegistry()` and `getSpanDefinitions()` from registry-types.ts.
 * Returns each span's ID and optional brief for use in similarity comparisons.
 *
 * @param resolvedRegistry - Raw resolved registry object from `weaver registry resolve -f json`
 * @returns Array of span definitions (id + optional brief)
 */
export function extractSpanDefinitions(resolvedRegistry: object): SpanDefinition[] {
  const registry = parseResolvedRegistry(resolvedRegistry);
  const spanGroups = getSpanDefinitions(registry);
  return spanGroups.map((g) => ({
    id: g.id,
    ...(g.brief !== undefined ? { brief: g.brief } : {}),
  }));
}

// ---------------------------------------------------------------------------
// Tokenize / Jaccard helpers
// duplicated from sch004.ts — extract in a follow-up
// ---------------------------------------------------------------------------

/**
 * Tokenize a span ID by splitting on common delimiters (., _, -).
 * Converts to lowercase for case-insensitive comparison.
 */
function tokenize(name: string): Set<string> {
  return new Set(
    name
      .toLowerCase()
      .split(/[.\-_]/)
      .filter((t) => t.length > 0),
  );
}

/**
 * Compute Jaccard similarity between two token sets.
 * |A ∩ B| / |A ∪ B|
 */
function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;

  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection++;
  }

  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// ---------------------------------------------------------------------------
// Main check
// ---------------------------------------------------------------------------

/**
 * SCH-005: Flag span definitions in the resolved registry that may be semantic duplicates.
 *
 * Two-tier detection:
 * 1. Script: Jaccard token similarity >0.5 on span IDs catches obvious duplicates
 * 2. Judge (optional, M3): For pairs in the gap (0.2–0.5), an LLM judge evaluates
 *    semantic equivalence with namespace pre-filtering.
 *
 * This is a run-level advisory check — all findings are non-blocking.
 *
 * @param resolvedRegistry - Raw resolved registry object from `weaver registry resolve -f json`
 * @param judgeDeps - Optional judge dependencies. When absent, runs script-only.
 * @returns Sch005Result with check results and judge token usage for cost tracking
 */
export async function checkRegistrySpanDuplicates(
  resolvedRegistry: object,
  judgeDeps?: Sch005JudgeDeps,
): Promise<Sch005Result> {
  const spans = extractSpanDefinitions(resolvedRegistry);

  if (spans.length < 2) {
    return {
      results: [pass('Fewer than two span definitions — nothing to compare for duplicates.')],
      judgeTokenUsage: [],
    };
  }

  const scriptFindings: CheckResult[] = [];
  const jaccardGapPairs: Array<{ a: SpanDefinition; b: SpanDefinition; similarity: number }> = [];

  // Script tier: compare all pairs
  for (let i = 0; i < spans.length; i++) {
    for (let j = i + 1; j < spans.length; j++) {
      const a = spans[i];
      const b = spans[j];
      if (!a || !b) continue;

      // Namespace gate: skip cross-domain pairs deterministically (D-1)
      const rootA = getRootNamespace(a.id);
      const rootB = getRootNamespace(b.id);
      if (rootA === null || rootB === null || rootA !== rootB) continue;

      const tokensA = tokenize(a.id);
      const tokensB = tokenize(b.id);
      const sim = jaccardSimilarity(tokensA, tokensB);

      if (sim > 0.5) {
        scriptFindings.push({
          ruleId: 'SCH-005',
          passed: false,
          filePath: '<run-level>',
          lineNumber: null,
          message:
            `Span IDs "${a.id}" and "${b.id}" may be semantic duplicates ` +
            `(${Math.round(sim * 100)}% token overlap). Consider consolidating into a single span definition.`,
          tier: 2,
          blocking: false,
        });
      } else if (sim > 0.2) {
        // Jaccard gap — candidates for the judge tier (M3)
        jaccardGapPairs.push({ a, b, similarity: sim });
      }
    }
  }

  // Judge tier — handled in M3
  const judgeTokenUsage: TokenUsage[] = [];
  const judgeFindings: CheckResult[] = [];

  if (judgeDeps && jaccardGapPairs.length > 0) {
    for (const { a, b } of jaccardGapPairs) {
      // Pre-filter: skip pairs from different root namespaces (deterministic)
      const rootA = getRootNamespace(a.id);
      const rootB = getRootNamespace(b.id);
      if (rootA === null || rootB === null || rootA !== rootB) continue;

      const result = await callJudge(
        {
          ruleId: 'SCH-005',
          context:
            `Span ID "${a.id}"${a.brief ? ` (brief: "${a.brief}")` : ''} and ` +
            `span ID "${b.id}"${b.brief ? ` (brief: "${b.brief}")` : ''} have moderate token overlap ` +
            `and share the root namespace "${rootA}".`,
          question:
            `Are span IDs "${a.id}" and "${b.id}" semantically distinct — do they represent different operations? ` +
            `Answer true if they represent clearly different operations. ` +
            `Answer false if they are semantic duplicates (the same operation named differently). ` +
            `Brief for "${a.id}": ${a.brief ?? 'not provided'}. ` +
            `Brief for "${b.id}": ${b.brief ?? 'not provided'}. ` +
            `Spans with different structural roles or value semantics are NOT duplicates even if their names share words.`,
          candidates: [a.id, b.id],
        },
        judgeDeps.client,
        judgeDeps.options,
      );

      if (result) {
        judgeTokenUsage.push(result.tokenUsage);

        if (!result.verdict) continue;

        if (!result.verdict.answer && result.verdict.confidence >= 0.7) {
          // Post-validate: re-confirm namespace match (D-1 safety net)
          const postRootA = getRootNamespace(a.id);
          const postRootB = getRootNamespace(b.id);
          if (postRootA === null || postRootB === null || postRootA !== postRootB) continue;

          judgeFindings.push({
            ruleId: 'SCH-005',
            passed: false,
            filePath: '<run-level>',
            lineNumber: null,
            message:
              `Span IDs "${a.id}" and "${b.id}" appear to be semantic duplicates ` +
              `(judge confidence: ${Math.round(result.verdict.confidence * 100)}%). ` +
              `Consider consolidating into a single span definition.`,
            tier: 2,
            blocking: false,
          });
        }
      }
      // If result is null (judge failure), silently skip
    }
  }

  const allFindings = [...scriptFindings, ...judgeFindings];

  if (allFindings.length === 0) {
    return {
      results: [pass('No potentially duplicate span definitions detected.')],
      judgeTokenUsage,
    };
  }

  return { results: allFindings, judgeTokenUsage };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract the root namespace segment from a span ID.
 * For "span.commit_story.generate", returns "commit_story".
 * Returns null if the ID does not have the expected "span.<namespace>..." shape.
 */
function getRootNamespace(spanId: string): string | null {
  const parts = spanId.split('.');
  // Expect at least "span.<root>" — two segments minimum
  if (parts.length < 2 || parts[0] !== 'span') return null;
  return parts[1] ?? null;
}

function pass(message: string): CheckResult {
  return {
    ruleId: 'SCH-005',
    passed: true,
    filePath: '<run-level>',
    lineNumber: null,
    message,
    tier: 2,
    blocking: false,
  };
}

// ---------------------------------------------------------------------------
// Per-file ValidationRule stub
// ---------------------------------------------------------------------------

/**
 * SCH-005 per-file ValidationRule.
 *
 * SCH-005 is a run-level check — it compares all span definitions in the final
 * resolved registry, not within a single file. The actual check runs at
 * coordinator level via `checkRegistrySpanDuplicates(resolvedRegistry)`.
 *
 * This per-file rule always passes. It exists so SCH-005 appears in the
 * rule registry and the feature parity matrix can verify the provider
 * has an implementation of this rule concept.
 */
export const sch005Rule: ValidationRule = {
  ruleId: 'SCH-005',
  dimension: 'Schema',
  blocking: false,
  applicableTo(_language: string): boolean {
    return true;
  },
  check(input) {
    return {
      ruleId: 'SCH-005',
      passed: true,
      filePath: input.filePath,
      lineNumber: null,
      message: 'SCH-005: Cross-run span deduplication check runs at coordinator level.',
      tier: 2,
      blocking: false,
    };
  },
};

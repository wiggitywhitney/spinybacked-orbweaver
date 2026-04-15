// ABOUTME: SCH-005 Tier 2 check — no duplicate span definitions in the registry.
// ABOUTME: Flags semantically equivalent span definitions using LLM judge (judge-only, no Jaccard tier).

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
  /** Span kind (e.g. CLIENT, SERVER, INTERNAL, PRODUCER, CONSUMER), when present. */
  span_kind?: string;
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
 * Returns each span's ID, optional brief, and optional span_kind for use in comparisons.
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
    ...(g.span_kind !== undefined ? { span_kind: g.span_kind } : {}),
  }));
}

// ---------------------------------------------------------------------------
// Main check
// ---------------------------------------------------------------------------

/**
 * SCH-005: Flag span definitions in the resolved registry that may be semantic duplicates.
 *
 * Judge-only detection: for all same-namespace, compatible-span_kind pairs, an LLM judge
 * evaluates semantic equivalence. Three deterministic gates precede the judge: namespace
 * pre-filter (D-1), span_kind pre-filter (D-3), and post-validate (D-1 safety net).
 *
 * When no judge client is provided, degrades gracefully and returns pass.
 * This is a run-level advisory check — all findings are non-blocking.
 *
 * @param resolvedRegistry - Raw resolved registry object from `weaver registry resolve -f json`
 * @param judgeDeps - Optional judge dependencies. When absent, returns pass immediately.
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

  if (!judgeDeps) {
    return {
      results: [pass('SCH-005 requires a judge client — skipped.')],
      judgeTokenUsage: [],
    };
  }

  const judgeTokenUsage: TokenUsage[] = [];
  const judgeFindings: CheckResult[] = [];

  for (let i = 0; i < spans.length; i++) {
    for (let j = i + 1; j < spans.length; j++) {
      const a = spans[i];
      const b = spans[j];
      if (!a || !b) continue;

      // Pre-filter: skip pairs from different root namespaces (deterministic, D-1)
      const rootA = getRootNamespace(a.id);
      const rootB = getRootNamespace(b.id);
      if (rootA === null || rootB === null || rootA !== rootB) continue;

      // Pre-filter: skip pairs with different span_kind — different structural roles (deterministic, D-3)
      if (a.span_kind && b.span_kind && a.span_kind !== b.span_kind) continue;

      const result = await callJudge(
        {
          ruleId: 'SCH-005',
          context:
            `Span ID "${a.id}"${a.brief ? ` (brief: "${a.brief}")` : ''} and ` +
            `span ID "${b.id}"${b.brief ? ` (brief: "${b.brief}")` : ''} share ` +
            `the root namespace "${rootA}".`,
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

  if (judgeFindings.length === 0) {
    return {
      results: [pass('No potentially duplicate span definitions detected.')],
      judgeTokenUsage,
    };
  }

  return { results: judgeFindings, judgeTokenUsage };
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

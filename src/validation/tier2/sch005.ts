// ABOUTME: SCH-005 Tier 2 check — no duplicate span definitions in the registry.
// ABOUTME: Flags semantically equivalent span definitions using Jaccard similarity + LLM judge.

import type Anthropic from '@anthropic-ai/sdk';
import type { CheckResult } from '../types.ts';
import type { TokenUsage } from '../../agent/schema.ts';
import { callJudge } from '../judge.ts';
import type { JudgeOptions } from '../judge.ts';
import { parseResolvedRegistry, getSpanDefinitions } from './registry-types.ts';

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

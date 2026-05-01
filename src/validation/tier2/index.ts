// ABOUTME: Public API for shared (language-agnostic) Tier 2 validation components.
// ABOUTME: Per-file SCH rule implementations have moved to src/languages/javascript/rules/.

// Registry type helpers (shared, used by SCH rules and instrument-with-retry)
export type {
  ResolvedRegistry,
  ResolvedRegistryGroup,
  ResolvedRegistryAttribute,
  ResolvedEnumType,
  ResolvedEnumMember,
} from './registry-types.ts';
export {
  parseResolvedRegistry,
  getSpanDefinitions,
  getAllAttributeNames,
  getAttributeDefinitions,
  isEnumType,
} from './registry-types.ts';

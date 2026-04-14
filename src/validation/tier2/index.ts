// ABOUTME: Public API for shared (language-agnostic) Tier 2 validation components.
// ABOUTME: Non-portable JS-specific checkers have moved to src/languages/javascript/rules/.

// CDQ-008: Cross-file tracer naming consistency check (shared, runs at coordinator level)
export { checkTracerNamingConsistency } from './cdq008.ts';
export type { FileContent } from './cdq008.ts';
export { cdq008Rule } from './cdq008.ts';


// SCH-001–005 shared validator helpers (extraction is JS-specific in languages/javascript/rules/)
export { checkSpanNamesMatchRegistry } from './sch001.ts';
export type { Sch001Result } from './sch001.ts';
export { checkAttributeKeysMatchRegistry } from './sch002.ts';
export { checkAttributeValuesConformToTypes } from './sch003.ts';
export { checkNoRedundantSchemaEntries } from './sch004.ts';
export type { Sch004JudgeDeps, Sch004Result } from './sch004.ts';
export { checkRegistrySpanDuplicates, extractSpanDefinitions, sch005Rule } from './sch005.ts';
export type { Sch005JudgeDeps, Sch005Result, SpanDefinition } from './sch005.ts';

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

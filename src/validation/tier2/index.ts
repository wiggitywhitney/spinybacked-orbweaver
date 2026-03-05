// ABOUTME: Public API for Tier 2 semantic validation checks.
// ABOUTME: Re-exports all Tier 2 checkers (CDQ-001, NDS-003, COV-002, RST-001, COV-005, CDQ-008).

export { checkSpansClosed } from './cdq001.ts';
export { checkNonInstrumentationDiff } from './nds003.ts';
export { checkOutboundCallSpans } from './cov002.ts';
export { checkUtilityFunctionSpans } from './rst001.ts';
export { checkDomainAttributes } from './cov005.ts';
export type { RegistrySpanDefinition } from './cov005.ts';
export { checkTracerNamingConsistency } from './cdq008.ts';
export type { FileContent } from './cdq008.ts';

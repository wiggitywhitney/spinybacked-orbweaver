// ABOUTME: Public API for Tier 2 semantic validation checks.
// ABOUTME: Re-exports all Tier 2 checkers for coverage, restraint, and quality dimensions.

export { checkSpansClosed } from './cdq001.ts';
export { checkNonInstrumentationDiff } from './nds003.ts';
export { checkOutboundCallSpans } from './cov002.ts';
export { checkUtilityFunctionSpans } from './rst001.ts';
export { checkDomainAttributes } from './cov005.ts';
export type { RegistrySpanDefinition } from './cov005.ts';
export { checkTracerNamingConsistency } from './cdq008.ts';
export type { FileContent } from './cdq008.ts';
export { checkEntryPointSpans } from './cov001.ts';
export { checkErrorVisibility } from './cov003.ts';
export { checkAsyncOperationSpans } from './cov004.ts';
export { checkAutoInstrumentationPreference } from './cov006.ts';
export { checkTrivialAccessorSpans } from './rst002.ts';
export { checkThinWrapperSpans } from './rst003.ts';
export { checkInternalDetailSpans } from './rst004.ts';
export { checkIsRecordingGuard } from './cdq006.ts';
export { checkSpanNamesMatchRegistry } from './sch001.ts';
export { checkAttributeKeysMatchRegistry } from './sch002.ts';
export { checkAttributeValuesConformToTypes } from './sch003.ts';
export { checkNoRedundantSchemaEntries } from './sch004.ts';
export type { Sch004JudgeDeps, Sch004Result } from './sch004.ts';
export type {
  ResolvedRegistry,
  ResolvedRegistryGroup,
  ResolvedRegistryAttribute,
  ResolvedEnumType,
  ResolvedEnumMember,
} from './registry-types.ts';
export { checkForbiddenImports } from './api001.ts';
export { checkOtelApiDependencyPlacement } from './api002.ts';
export { checkDoubleInstrumentation } from './rst005.ts';
export { checkModuleSystemMatch } from './nds006.ts';
export { checkExportedSignaturePreservation } from './nds004.ts';
export { checkControlFlowPreservation } from './nds005.ts';
export type { Nds005JudgeDeps, Nds005Result } from './nds005.ts';
export {
  parseResolvedRegistry,
  getSpanDefinitions,
  getAllAttributeNames,
  getAttributeDefinitions,
  isEnumType,
} from './registry-types.ts';

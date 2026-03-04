// ABOUTME: Public API for Tier 2 semantic validation checks.
// ABOUTME: Re-exports CDQ-001 (span closure) and NDS-003 (non-instrumentation diff).

export { checkSpansClosed } from './cdq001.ts';
export { checkNonInstrumentationDiff } from './nds003.ts';

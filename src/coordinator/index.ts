// ABOUTME: Public API for the coordinator module.
// ABOUTME: Re-exports file discovery, dispatch, and coordinator types.

export { discoverFiles } from './discovery.ts';
export type { DiscoverFilesOptions } from './discovery.ts';
export { isAlreadyInstrumented, buildSkippedResult, dispatchFiles, resolveSchema } from './dispatch.ts';
export type { CoordinatorCallbacks, CostCeiling, RunResult, DispatchFilesDeps } from './types.ts';

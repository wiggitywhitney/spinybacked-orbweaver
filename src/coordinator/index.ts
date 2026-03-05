// ABOUTME: Public API for the coordinator module.
// ABOUTME: Re-exports file discovery, dispatch, and coordinator types.

export { coordinate, CoordinatorAbortError } from './coordinate.ts';
export type { CoordinateDeps } from './coordinate.ts';
export { discoverFiles } from './discovery.ts';
export type { DiscoverFilesOptions } from './discovery.ts';
export { isAlreadyInstrumented, buildSkippedResult, dispatchFiles, resolveSchema } from './dispatch.ts';
export { aggregateResults, collectLibraries, finalizeResults } from './aggregate.ts';
export type { FinalizeDeps } from './aggregate.ts';
export { updateSdkInitFile } from './sdk-init.ts';
export type { SdkInitResult } from './sdk-init.ts';
export { installDependencies } from './dependencies.ts';
export type { DependencyInstallResult, InstallDeps } from './dependencies.ts';
export { writeSchemaExtensions, collectSchemaExtensions, extractNamespacePrefix } from './schema-extensions.ts';
export type { WriteSchemaExtensionsResult } from './schema-extensions.ts';
export { computeSchemaHash } from './schema-hash.ts';
export type { CoordinatorCallbacks, CostCeiling, RunResult, DispatchFilesDeps } from './types.ts';

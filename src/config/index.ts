// ABOUTME: Public API for config module.
// ABOUTME: Re-exports schema, types, and loader functions.

export { AgentConfigSchema } from './schema.ts';
export type { AgentConfig } from './schema.ts';
export { loadConfig, validateConfig } from './loader.ts';
export {
  checkPackageJson,
  checkOtelApiDependency,
  checkSdkInitFile,
  checkWeaverSchema,
  checkPrerequisites,
  PREREQUISITE_IDS,
} from './prerequisites.ts';
export type {
  PrerequisiteId,
  PrerequisiteCheckResult,
  PrerequisitesResult,
} from './prerequisites.ts';

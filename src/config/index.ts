// ABOUTME: Public API for config module.
// ABOUTME: Re-exports schema, types, and loader functions.

export { AgentConfigSchema } from './schema.ts';
export type { AgentConfig } from './schema.ts';
export { loadConfig, validateConfig } from './loader.ts';

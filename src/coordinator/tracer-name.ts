// ABOUTME: Resolves the canonical tracer name for a project.
// ABOUTME: Config tracerName overrides registry-derived name; registry name normalizes underscores to hyphens.

import type { AgentConfig } from '../config/schema.ts';
import { extractNamespacePrefix } from './schema-extensions.ts';

/**
 * Resolves the canonical tracer name for a project.
 *
 * Priority order:
 * 1. `config.tracerName` — used as-is when set
 * 2. Registry manifest `name` field — underscores replaced with hyphens
 *
 * @param config - Validated agent configuration
 * @param registryDir - Absolute path to the Weaver registry directory
 * @returns The canonical tracer name to use in all trace.getTracer() calls
 */
export async function resolveCanonicalTracerName(config: AgentConfig, registryDir: string): Promise<string> {
  if (config.tracerName !== undefined) {
    return config.tracerName;
  }
  const manifestName = await extractNamespacePrefix(registryDir);
  return manifestName.replace(/_/g, '-');
}

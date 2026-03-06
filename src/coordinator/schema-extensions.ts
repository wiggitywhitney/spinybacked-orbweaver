// ABOUTME: Schema extension YAML generation for the coordinator module.
// ABOUTME: Writes agent-requested schema extensions to agent-extensions.yaml in the registry directory.

import { readFile, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import type { FileResult } from '../fix-loop/types.ts';

/** Result of writing schema extensions to disk. */
export interface WriteSchemaExtensionsResult {
  /** Whether the file was written (false if no valid extensions). */
  written: boolean;
  /** Number of valid extensions written. */
  extensionCount: number;
  /** Absolute path to the written file (set even if written=false). */
  filePath: string;
  /** Extension IDs that were rejected (wrong namespace prefix). */
  rejected: string[];
}

/** The filename used for agent-generated schema extensions. */
const EXTENSIONS_FILENAME = 'agent-extensions.yaml';

/**
 * Collect schema extension strings from successful file results.
 * Skips failed/skipped files and deduplicates by raw string content.
 *
 * @param results - Array of FileResult objects from the dispatch phase
 * @returns Deduplicated array of schema extension YAML strings
 */
export function collectSchemaExtensions(results: FileResult[]): string[] {
  const seen = new Set<string>();
  const extensions: string[] = [];

  for (const result of results) {
    if (result.status !== 'success') continue;
    for (const ext of result.schemaExtensions) {
      if (!seen.has(ext)) {
        seen.add(ext);
        extensions.push(ext);
      }
    }
  }

  return extensions;
}

/**
 * Extract the project namespace prefix from the registry manifest.
 * Reads registry_manifest.yaml and returns the `name` field.
 *
 * @param registryDir - Absolute path to the Weaver registry directory
 * @returns The project namespace prefix (e.g., "commit_story")
 * @throws When registry_manifest.yaml is missing or has no `name` field
 */
export async function extractNamespacePrefix(registryDir: string): Promise<string> {
  const manifestPath = join(registryDir, 'registry_manifest.yaml');
  let content: string;
  try {
    content = await readFile(manifestPath, 'utf-8');
  } catch {
    throw new Error(
      `Cannot read registry_manifest.yaml at ${manifestPath} — ` +
      'ensure the registry directory contains a valid manifest.',
    );
  }

  const manifest = parse(content) as Record<string, unknown>;
  if (typeof manifest?.name !== 'string' || manifest.name.length === 0) {
    throw new Error(
      `registry_manifest.yaml at ${manifestPath} is missing a "name" field — ` +
      'the name field defines the project namespace prefix for schema extensions.',
    );
  }

  return manifest.name;
}

/**
 * Parse a schema extension YAML string into a structured attribute object.
 * Each extension string is expected to be a YAML list item (with leading "- ").
 *
 * @param extensionYaml - YAML string for a single attribute definition
 * @returns Parsed attribute object, or null if parsing fails
 */
export function parseExtension(extensionYaml: string): Record<string, unknown> | null {
  try {
    // The extension is a YAML list item — parse it as a list
    const parsed = parse(extensionYaml) as unknown;
    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed[0] as Record<string, unknown>;
    }
    // If it parsed as an object directly, use that
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Write agent-requested schema extensions to agent-extensions.yaml.
 *
 * Parses each extension string as YAML, validates the namespace prefix,
 * wraps valid extensions in a Weaver attribute_group, and writes to disk.
 * One file per run — overwrites any previous agent-extensions.yaml.
 *
 * @param registryDir - Absolute path to the Weaver registry directory
 * @param extensions - Array of schema extension YAML strings from agent output
 * @returns Result indicating what was written and any rejections
 */
export async function writeSchemaExtensions(
  registryDir: string,
  extensions: string[],
): Promise<WriteSchemaExtensionsResult> {
  const filePath = join(registryDir, EXTENSIONS_FILENAME);

  if (extensions.length === 0) {
    return { written: false, extensionCount: 0, filePath, rejected: [] };
  }

  const namespacePrefix = await extractNamespacePrefix(registryDir);
  const validAttributes: Array<Record<string, unknown>> = [];
  const rejected: string[] = [];

  for (const ext of extensions) {
    const attr = parseExtension(ext);
    if (!attr) {
      rejected.push(`(unparseable): ${ext.slice(0, 80)}`);
      continue;
    }

    const id = attr.id as string | undefined;
    if (!id || !id.startsWith(`${namespacePrefix}.`)) {
      rejected.push(String(id ?? '(no id)'));
      continue;
    }

    validAttributes.push(attr);
  }

  if (validAttributes.length === 0) {
    return { written: false, extensionCount: 0, filePath, rejected };
  }

  const yamlContent = stringify({
    groups: [{
      id: `registry.${namespacePrefix}.agent_extensions`,
      type: 'attribute_group',
      display_name: 'Agent-Created Attributes',
      brief: 'Attributes created by the instrumentation agent',
      attributes: validAttributes,
    }],
  });

  await writeFile(filePath, yamlContent, 'utf-8');

  return {
    written: true,
    extensionCount: validAttributes.length,
    filePath,
    rejected,
  };
}

/**
 * Snapshot the current agent-extensions.yaml file content.
 * Returns the file content as a string, or null if the file does not exist.
 *
 * @param registryDir - Absolute path to the Weaver registry directory
 * @returns File content string, or null if absent
 */
export async function snapshotExtensionsFile(registryDir: string): Promise<string | null> {
  const filePath = join(registryDir, EXTENSIONS_FILENAME);
  try {
    return await readFile(filePath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

/**
 * Restore agent-extensions.yaml to a previous state.
 * If the snapshot is a string, writes that content back to the file.
 * If the snapshot is null (file was absent), deletes the file.
 *
 * @param registryDir - Absolute path to the Weaver registry directory
 * @param snapshot - Previous file content (string) or null (file was absent)
 */
export async function restoreExtensionsFile(
  registryDir: string,
  snapshot: string | null,
): Promise<void> {
  const filePath = join(registryDir, EXTENSIONS_FILENAME);
  if (snapshot === null) {
    try {
      await unlink(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  } else {
    await writeFile(filePath, snapshot, 'utf-8');
  }
}

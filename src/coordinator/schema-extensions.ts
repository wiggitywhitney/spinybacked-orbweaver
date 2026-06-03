// ABOUTME: Schema extension YAML generation for the coordinator module.
// ABOUTME: Writes agent-requested schema extensions to agent-extensions.yaml in the registry directory.

import { readFile, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import type Anthropic from '@anthropic-ai/sdk';
import type { FileResult } from '../fix-loop/types.ts';
import type { TokenUsage } from '../agent/schema.ts';
import type { JudgeOptions } from '../validation/judge.ts';
import {
  normalizeKey,
  computeJaccardSimilarity,
  JACCARD_DUPLICATE_THRESHOLD,
  checkSemanticDuplicate,
} from '../languages/javascript/rules/semantic-dedup.ts';
import type { RegistryEntry } from '../languages/javascript/rules/semantic-dedup.ts';

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
 * Collect schema extension strings from successful and partial file results.
 * Skips failed/skipped files and deduplicates by raw string content.
 *
 * @param results - Array of FileResult objects from the dispatch phase
 * @returns Deduplicated array of schema extension YAML strings
 */
export function collectSchemaExtensions(results: FileResult[]): string[] {
  const seen = new Set<string>();
  const extensions: string[] = [];

  for (const result of results) {
    if (result.status !== 'success' && result.status !== 'partial') continue;
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
 * Like extractNamespacePrefix but returns undefined when registry_manifest.yaml does not
 * exist yet (ENOENT) instead of throwing. Propagates all other errors (malformed manifest,
 * permission errors) so callers can distinguish "not created yet" from "misconfigured".
 *
 * @param registryDir - Absolute path to the Weaver registry directory
 * @returns The namespace prefix, or undefined if the manifest is absent
 * @throws When the manifest exists but has no valid `name` field, or on permission errors
 */
export async function tryExtractNamespacePrefix(registryDir: string): Promise<string | undefined> {
  const manifestPath = join(registryDir, 'registry_manifest.yaml');
  let content: string;
  try {
    content = await readFile(manifestPath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
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
    // Bare string ID from LLM output (e.g., "myapp.context.collect" or "span.myapp.process_order")
    // Wrap in a minimal object with the ID and sensible defaults.
    if (typeof parsed === 'string' && parsed.includes('.')) {
      if (parsed.startsWith('span.')) {
        return {
          id: parsed,
          type: 'span',
          stability: 'development',
          brief: `Agent-discovered span: ${parsed.slice('span.'.length)}`,
          span_kind: 'internal',
        };
      }
      return {
        id: parsed,
        type: 'string',
        stability: 'development',
        brief: `Agent-discovered attribute: ${parsed}`,
      };
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

  // Seed from the existing agent-extensions.yaml so extensions from previous runs
  // (e.g. files that were skipped or failed in this run) are not silently dropped.
  // New extensions win on ID conflict (allows schema refinement across runs).
  const existingAttributes = new Map<string, Record<string, unknown>>();
  const existingSpans = new Map<string, Record<string, unknown>>();
  try {
    const existingContent = await readFile(filePath, 'utf-8');
    const existingParsed = parse(existingContent) as Record<string, unknown>;
    const existingGroups = Array.isArray(existingParsed?.groups)
      ? (existingParsed.groups as Array<Record<string, unknown>>)
      : [];
    for (const group of existingGroups) {
      if (!group || typeof group !== 'object') continue;
      if (group.type === 'attribute_group' && Array.isArray(group.attributes)) {
        for (const attr of group.attributes as Array<Record<string, unknown>>) {
          if (typeof attr?.id === 'string') existingAttributes.set(attr.id, attr);
        }
      } else if (group.type === 'span' && typeof group.id === 'string') {
        existingSpans.set(group.id, group);
      }
    }
  } catch (err) {
    // Only suppress ENOENT (file not yet created). Rethrow permission errors,
    // corrupt YAML, and other unexpected failures so they surface explicitly.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  const validAttributes: Array<Record<string, unknown>> = [];
  const validSpans: Array<Record<string, unknown>> = [];
  const rejected: string[] = [];

  for (const ext of extensions) {
    const attr = parseExtension(ext);
    if (!attr) {
      rejected.push(`(unparseable): ${ext.slice(0, 80)}`);
      continue;
    }

    if (typeof attr.id !== 'string' || attr.id.length === 0) {
      rejected.push(String(attr.id ?? '(no id)'));
      continue;
    }
    const id = attr.id;

    // Span-type extensions have IDs like "span.myapp.process_order" —
    // strip the "span." prefix before checking the namespace.
    const isSpan = id.startsWith('span.') || attr.type === 'span';
    const namespacePart = isSpan && id.startsWith('span.') ? id.slice('span.'.length) : id;

    if (!namespacePart.startsWith(`${namespacePrefix}.`)) {
      rejected.push(id);
      continue;
    }

    // Correct count attribute types: *_count and *.count should be int, not string.
    // The first file may declare these as string, propagating the wrong type to
    // all subsequent files via the schema accumulator.
    if (!isSpan && (id.endsWith('_count') || id.endsWith('.count')) && attr.type === 'string') {
      attr.type = 'int';
    }

    // Correct boolean attribute types: names containing is_, has_, should_, or
    // ending with .force indicate boolean semantics. The schema accumulator
    // defaults these to string, but they should be boolean.
    if (!isSpan && attr.type === 'string') {
      const lastSegment = id.split('.').pop() ?? '';
      if (/^(is|has|should)_/.test(lastSegment) || lastSegment === 'force') {
        attr.type = 'boolean';
      }
    }

    if (isSpan) {
      validSpans.push(attr);
    } else {
      validAttributes.push(attr);
    }
  }

  if (validAttributes.length === 0 && validSpans.length === 0) {
    return { written: false, extensionCount: 0, filePath, rejected };
  }

  // Merge: new extensions win on ID conflict; existing entries not in new set are preserved.
  for (const attr of validAttributes) existingAttributes.set(attr.id as string, attr);
  for (const span of validSpans) existingSpans.set(span.id as string, span);

  const mergedAttributes = [...existingAttributes.values()];
  const mergedSpans = [...existingSpans.values()];

  const groups: Array<Record<string, unknown>> = [];

  if (mergedAttributes.length > 0) {
    groups.push({
      id: `registry.${namespacePrefix}.agent_extensions`,
      type: 'attribute_group',
      display_name: 'Agent-Created Attributes',
      brief: 'Attributes created by the instrumentation agent',
      attributes: mergedAttributes,
    });
  }

  if (mergedSpans.length > 0) {
    for (const span of mergedSpans) {
      groups.push({
        ...span,
        type: 'span',
        stability: span.stability ?? 'development',
        brief: span.brief ?? 'Agent-discovered span',
        span_kind: span.span_kind ?? 'internal',
      });
    }
  }

  const yamlContent = stringify({ groups });

  await writeFile(filePath, yamlContent, 'utf-8');

  return {
    written: true,
    extensionCount: validAttributes.length + validSpans.length,
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

/**
 * Pre-filter a candidate attribute key against the registry before invoking the LLM judge.
 * Returns true when the candidate is a near-duplicate and should NOT be auto-registered.
 * Returns false when the candidate is genuinely novel and should proceed to the judge.
 *
 * Two stages:
 * 1. Normalization: lowercase, strip delimiters (._-) — catches exact matches and
 *    delimiter-variant duplicates (e.g., http_request_method vs http.request.method).
 * 2. Jaccard token similarity above JACCARD_DUPLICATE_THRESHOLD — catches structural
 *    near-duplicates (e.g., commit_story.git.diff_lines vs commit_story.git.diff_stats).
 *
 * @param candidate - The attribute key to evaluate
 * @param registryNames - Set of all attribute key names currently in the resolved registry
 * @returns true if the candidate should be filtered (near-duplicate), false if genuinely novel
 */
export function preFilterAutoRegistrationCandidate(
  candidate: string,
  registryNames: ReadonlySet<string>,
): boolean {
  const normalizedCandidate = normalizeKey(candidate);
  for (const name of registryNames) {
    if (normalizedCandidate === normalizeKey(name)) return true;
    if (computeJaccardSimilarity(candidate, name) > JACCARD_DUPLICATE_THRESHOLD) return true;
  }
  return false;
}

/**
 * Extract span names used in startActiveSpan calls from instrumented code.
 *
 * Finds all `startActiveSpan('name', ...)` and `startActiveSpan("name", ...)`
 * calls and returns the unique literal string span names. Dynamic span names
 * (template literals, variables) are intentionally ignored.
 *
 * @param code - Instrumented JavaScript source code
 * @returns Deduplicated array of span name strings found in the code
 */
export function extractSpanNamesFromCode(code: string): string[] {
  const names = new Set<string>();
  // Match tracer.startActiveSpan('name', ...), tracer.startSpan('name', ...),
  // and bare startActiveSpan/startSpan calls (dot optional). Tolerates optional whitespace.
  const pattern = /\.?\s*(?:startActiveSpan|startSpan)\s*\(\s*(['"])([^'"]+)\1/g;
  for (const match of code.matchAll(pattern)) {
    names.add(match[2]!);
  }
  return [...names];
}

// ---------------------------------------------------------------------------
// Auto-registration LLM judge (M3)
// ---------------------------------------------------------------------------

/** LLM judge dependencies for auto-registration candidate evaluation. */
export interface AutoRegistrationJudgeDeps {
  client: Anthropic;
  options?: JudgeOptions;
}

/** Result of running the LLM judge on auto-registration candidates. */
export interface AutoRegistrationJudgeResult {
  /** Candidate keys the judge confirmed as novel — safe to auto-register. */
  novel: string[];
  /** Candidate keys the judge flagged as semantic duplicates — do not register. */
  duplicates: string[];
  /** Token usage accumulated across all judge calls. */
  judgeTokenUsage: TokenUsage[];
}

/**
 * Run the LLM judge on candidates that survived the pre-filter (M2).
 *
 * Each candidate is passed to checkSemanticDuplicate with the Jaccard stage
 * disabled — candidates have already survived both normalization and Jaccard
 * in the M2 pre-filter, so re-running those stages would be redundant.
 *
 * OQ-1 note: run-20 commit-story-v2 has 18 distinct setAttribute keys across
 * 12 files, all commit_story.* or standard OTel (vcs.*, gen_ai.*). After
 * pre-filtering out standard OTel keys, the expected judge call count per run
 * is ~15-18, below the 20-call threshold — no ceiling parameter is required.
 *
 * @param candidates - Attribute keys that survived the M2 pre-filter
 * @param registryEntries - Current registry entries for semantic comparison
 * @param judgeDeps - Anthropic client and optional judge configuration
 * @returns Novel keys, duplicate keys, and accumulated token usage
 */
export async function runAutoRegistrationJudge(
  candidates: string[],
  registryEntries: RegistryEntry[],
  judgeDeps: AutoRegistrationJudgeDeps,
): Promise<AutoRegistrationJudgeResult> {
  const novel: string[] = [];
  const duplicates: string[] = [];
  const allJudgeTokenUsage: TokenUsage[] = [];

  for (const candidate of candidates) {
    try {
      const result = await checkSemanticDuplicate(candidate, registryEntries, {
        ruleId: 'auto-registration',
        useJaccard: false,
        judgeDeps: { client: judgeDeps.client, options: judgeDeps.options },
      });

      allJudgeTokenUsage.push(...result.judgeTokenUsage);

      if (result.isDuplicate) {
        duplicates.push(candidate);
      } else {
        novel.push(candidate);
      }
    } catch {
      // Judge call failed — treat as novel so auto-registration proceeds rather than
      // silently dropping a candidate that may be genuinely new.
      novel.push(candidate);
    }
  }

  return { novel, duplicates, judgeTokenUsage: allJudgeTokenUsage };
}

/**
 * Extract literal attribute keys from setAttribute calls in instrumented code.
 *
 * Finds all `<span>.setAttribute('key', ...)` and `<span>.setAttribute("key", ...)`
 * calls and returns the unique literal string keys. Dynamic keys (template literals,
 * variables) are intentionally ignored.
 *
 * @param code - Instrumented JavaScript source code
 * @returns Deduplicated array of attribute key strings found in the code
 */
export function extractAttributeKeysFromCode(code: string): string[] {
  const keys = new Set<string>();
  // Match <anything>.setAttribute('key', ...) — requires a leading dot so bare function
  // calls without a receiver are excluded. Only single/double quoted literals are captured;
  // template literals and variables do not match the quote character class.
  // (?:\n\s*)? allows one optional newline+indent between ( and the key quote, which
  // handles Prettier-reformatted multi-line calls where the key is on a continuation line.
  const pattern = /\.setAttribute\s*\(\s*(?:\n\s*)?(['"])([^'"]+)\1/g;
  for (const match of code.matchAll(pattern)) {
    keys.add(match[2]!);
  }
  return [...keys];
}

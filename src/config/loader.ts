// ABOUTME: Config loading from YAML files with validation and typo detection.
// ABOUTME: Returns structured results for all outcomes — success, file errors, parse errors, validation errors.

import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import { AgentConfigSchema } from './schema.ts';
import type { AgentConfig } from './schema.ts';

/** Error codes returned by config loading/validation. */
const CONFIG_ERROR_CODES = {
  FILE_NOT_FOUND: 'FILE_NOT_FOUND',
  YAML_PARSE_ERROR: 'YAML_PARSE_ERROR',
  INVALID_CONFIG: 'INVALID_CONFIG',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  UNKNOWN_FIELDS: 'UNKNOWN_FIELDS',
} as const;

type ConfigErrorCode = typeof CONFIG_ERROR_CODES[keyof typeof CONFIG_ERROR_CODES];

interface ConfigError {
  code: ConfigErrorCode;
  message: string;
}

type ConfigResult =
  | { success: true; config: AgentConfig }
  | { success: false; error: ConfigError };

/** Known field names from the AgentConfig schema, used for typo suggestions. */
const KNOWN_FIELDS = Object.keys(AgentConfigSchema.shape);

/**
 * Load and validate an orb.yaml config file.
 *
 * @param filePath - Absolute or relative path to the YAML config file
 * @returns Structured result with validated config or descriptive error
 */
export async function loadConfig(filePath: string): Promise<ConfigResult> {
  let rawContent: string;
  try {
    rawContent = await readFile(filePath, 'utf-8');
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: {
        code: CONFIG_ERROR_CODES.FILE_NOT_FOUND,
        message: `Config file not found: ${filePath} — ${message}`,
      },
    };
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(rawContent);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: {
        code: CONFIG_ERROR_CODES.YAML_PARSE_ERROR,
        message: `Failed to parse YAML: ${message}`,
      },
    };
  }

  if (parsed === null || parsed === undefined || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      success: false,
      error: {
        code: CONFIG_ERROR_CODES.INVALID_CONFIG,
        message: `Config file must contain a YAML object, got ${Array.isArray(parsed) ? 'array' : typeof parsed}`,
      },
    };
  }

  return validateConfig(parsed as Record<string, unknown>);
}

/**
 * Validate a parsed config object against the AgentConfig schema.
 * Checks for unknown fields first (with typo suggestions), then validates schema.
 *
 * @param input - Raw parsed object (e.g., from YAML)
 * @returns Structured result with validated config or descriptive error
 */
export function validateConfig(input: Record<string, unknown>): ConfigResult {
  // Check for unknown fields before schema validation (better error messages)
  const unknownFields = Object.keys(input).filter(key => !KNOWN_FIELDS.includes(key));

  if (unknownFields.length > 0) {
    const suggestions = unknownFields.map(field => {
      const closest = findClosestField(field);
      if (closest) {
        return `Unknown config field '${field}' — did you mean '${closest}'?`;
      }
      return `Unknown config field '${field}'`;
    });

    return {
      success: false,
      error: {
        code: CONFIG_ERROR_CODES.UNKNOWN_FIELDS,
        message: suggestions.join('\n'),
      },
    };
  }

  const result = AgentConfigSchema.safeParse(input);

  if (!result.success) {
    const issues = result.error.issues.map(
      (issue) => issue.path.length > 0
        ? `${issue.path.join('.')}: ${issue.message}`
        : issue.message
    );
    return {
      success: false,
      error: {
        code: CONFIG_ERROR_CODES.VALIDATION_ERROR,
        message: `Config validation failed:\n${issues.join('\n')}`,
      },
    };
  }

  return { success: true, config: result.data };
}

/**
 * Find the closest known field name to the given unknown field using Levenshtein distance.
 * Returns null if no field is within a reasonable edit distance (threshold: 5).
 */
function findClosestField(unknown: string): string | null {
  const MAX_DISTANCE = 5;
  let bestField: string | null = null;
  let bestDistance = MAX_DISTANCE + 1;

  for (const known of KNOWN_FIELDS) {
    const distance = levenshtein(unknown.toLowerCase(), known.toLowerCase());
    if (distance < bestDistance) {
      bestDistance = distance;
      bestField = known;
    }
  }

  return bestDistance <= MAX_DISTANCE ? bestField : null;
}

/**
 * Compute Levenshtein edit distance between two strings.
 * Standard dynamic programming implementation.
 */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;

  // Use single-row optimization
  const prev = Array.from({ length: n + 1 }, (_, i) => i);
  const curr = new Array<number>(n + 1);

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,       // deletion
        curr[j - 1] + 1,   // insertion
        prev[j - 1] + cost, // substitution
      );
    }
    // Swap rows
    for (let j = 0; j <= n; j++) {
      prev[j] = curr[j];
    }
  }

  return prev[n];
}

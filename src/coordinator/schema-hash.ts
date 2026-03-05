// ABOUTME: Schema hash computation for tracking registry changes across files.
// ABOUTME: Produces deterministic SHA-256 hashes from canonicalized JSON (sorted keys, no whitespace).

import { createHash } from 'node:crypto';

/**
 * Canonicalize a value by recursively sorting object keys.
 * Arrays maintain their element order (order-sensitive).
 * Produces a deterministic JSON representation regardless of key insertion order.
 *
 * @param value - Any JSON-serializable value
 * @returns A canonicalized version with sorted keys at every level
 */
function canonicalize(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }

  if (typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }

  return value;
}

/**
 * Compute a deterministic SHA-256 hash of a schema object.
 *
 * The schema is canonicalized (keys sorted at every level) and serialized
 * to JSON with no whitespace before hashing. This ensures identical schemas
 * produce identical hashes regardless of key insertion order.
 *
 * @param schema - The resolved schema object (from `weaver registry resolve`)
 * @returns Hex-encoded SHA-256 hash string (64 characters)
 */
export function computeSchemaHash(schema: object): string {
  const canonical = canonicalize(schema);
  const json = JSON.stringify(canonical);
  return createHash('sha256').update(json).digest('hex');
}

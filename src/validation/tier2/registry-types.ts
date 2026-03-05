// ABOUTME: Shared type definitions for resolved Weaver registry used by SCH checkers.
// ABOUTME: Describes the JSON structure produced by `weaver registry resolve -f json`.

/**
 * A single attribute in the resolved registry.
 * Attributes appear in both attribute groups and span definitions.
 */
export interface ResolvedRegistryAttribute {
  /** Attribute name (e.g. "http.request.method", "fixture_service.order.id"). */
  name: string;
  /** Attribute type — string literal ("string", "int", "double", "boolean", "string[]")
   *  or an enum object with members. */
  type?: string | ResolvedEnumType;
  /** Requirement level: "required", "recommended", "opt_in", etc. */
  requirement_level?: string;
  /** Human-readable description. */
  brief?: string;
  /** Example values from the registry. */
  examples?: unknown[];
  /** Stability marker. */
  stability?: string;
}

/**
 * Enum type definition — used when an attribute has a constrained set of values.
 */
export interface ResolvedEnumType {
  members: ResolvedEnumMember[];
}

/**
 * A single enum member value.
 */
export interface ResolvedEnumMember {
  id: string;
  value: string;
  brief?: string;
  stability?: string;
}

/**
 * A group in the resolved registry — either an attribute group or a span definition.
 */
export interface ResolvedRegistryGroup {
  /** Group ID (e.g. "registry.myapp.api" or "span.myapp.user.get_users"). */
  id: string;
  /** Group type — "attribute_group" for attribute definitions, "span" for span definitions. */
  type: string;
  /** Human-readable description. */
  brief?: string;
  /** Span kind (only for type: "span"). */
  span_kind?: string;
  /** Display name. */
  display_name?: string;
  /** Attributes defined or referenced by this group. */
  attributes?: ResolvedRegistryAttribute[];
  /** Stability marker. */
  stability?: string;
  /** Note/comment. */
  note?: string;
}

/**
 * The top-level resolved registry structure from `weaver registry resolve -f json`.
 */
export interface ResolvedRegistry {
  groups: ResolvedRegistryGroup[];
}

/**
 * Parse a resolved schema object into typed registry groups.
 * Returns empty groups array if the input doesn't have the expected shape.
 *
 * @param resolvedSchema - Raw object from `weaver registry resolve -f json`
 * @returns Typed resolved registry
 */
export function parseResolvedRegistry(resolvedSchema: object): ResolvedRegistry {
  if (!resolvedSchema || typeof resolvedSchema !== 'object') {
    return { groups: [] };
  }
  const schema = resolvedSchema as Record<string, unknown>;
  if (!Array.isArray(schema.groups)) {
    return { groups: [] };
  }
  return { groups: schema.groups as ResolvedRegistryGroup[] };
}

/**
 * Extract all span definitions from the resolved registry.
 * Span groups have IDs starting with "span." and type "span".
 *
 * @param registry - Parsed resolved registry
 * @returns Array of span groups
 */
export function getSpanDefinitions(registry: ResolvedRegistry): ResolvedRegistryGroup[] {
  return registry.groups.filter((g) => g.type === 'span');
}

/**
 * Extract all unique attribute names from the resolved registry.
 * Collects attributes from all groups (both attribute groups and span definitions).
 *
 * @param registry - Parsed resolved registry
 * @returns Set of all attribute names
 */
export function getAllAttributeNames(registry: ResolvedRegistry): Set<string> {
  const names = new Set<string>();
  for (const group of registry.groups) {
    if (group.attributes) {
      for (const attr of group.attributes) {
        names.add(attr.name);
      }
    }
  }
  return names;
}

/**
 * Build a lookup from attribute name to its definition.
 * When multiple definitions exist for the same name, the first one with
 * a type definition wins.
 *
 * @param registry - Parsed resolved registry
 * @returns Map from attribute name to its definition
 */
export function getAttributeDefinitions(
  registry: ResolvedRegistry,
): Map<string, ResolvedRegistryAttribute> {
  const defs = new Map<string, ResolvedRegistryAttribute>();
  for (const group of registry.groups) {
    if (group.attributes) {
      for (const attr of group.attributes) {
        const existing = defs.get(attr.name);
        // Prefer definitions that have type information
        if (!existing || (!existing.type && attr.type)) {
          defs.set(attr.name, attr);
        }
      }
    }
  }
  return defs;
}

/**
 * Check if a type value represents an enum type (object with members array).
 *
 * @param type - The type field from a ResolvedRegistryAttribute
 * @returns True if the type is an enum definition
 */
export function isEnumType(type: string | ResolvedEnumType | undefined): type is ResolvedEnumType {
  return typeof type === 'object' && type !== null && Array.isArray((type as ResolvedEnumType).members);
}

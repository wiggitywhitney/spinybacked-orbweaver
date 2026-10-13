// ABOUTME: Parses agent-declared schema extensions and corrects their types by attribute name.
// ABOUTME: Shared by the fix loop, the registry writer and SCH-003 so all three see the same type.

import { parse } from 'yaml';

/**
 * Correct an attribute extension's type from its name when the type is the
 * `string` default. Names ending in `_count` or `.count` are counts (`int`).
 * Names whose last segment starts with `is_`, `has_` or `should_`, or equals
 * `force`, are flags (`boolean`). Span extensions are left alone.
 *
 * This runs when an extension is parsed, not only when the registry is
 * written. SCH-003's auto-fix reads the parsed type to decide whether to wrap a
 * value in `String()`, so a count still typed `string` at that point gets cast
 * even though the registry later records it as `int`.
 */
export function correctExtensionType(attr: Record<string, unknown>): Record<string, unknown> {
  const id = attr['id'];
  if (typeof id !== 'string' || attr['type'] !== 'string') return attr;
  if (id.startsWith('span.')) return attr;

  if (id.endsWith('_count') || id.endsWith('.count')) {
    return { ...attr, type: 'int' };
  }
  const lastSegment = id.split('.').pop() ?? '';
  if (/^(is|has|should)_/.test(lastSegment) || lastSegment === 'force') {
    return { ...attr, type: 'boolean' };
  }
  return attr;
}

/**
 * Parse a schema extension YAML string into a structured attribute object.
 * Each extension string is expected to be a YAML list item (with leading "- "),
 * a YAML mapping, or a bare dotted ID. The returned attribute's type is
 * corrected by name (see `correctExtensionType`).
 *
 * @param extensionYaml - YAML string for a single attribute definition
 * @returns Parsed attribute object, or null if parsing fails
 */
export function parseExtension(extensionYaml: string): Record<string, unknown> | null {
  try {
    // The extension is a YAML list item — parse it as a list
    const parsed = parse(extensionYaml) as unknown;
    if (Array.isArray(parsed) && parsed.length > 0) {
      return correctExtensionType(parsed[0] as Record<string, unknown>);
    }
    // If it parsed as an object directly, use that
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return correctExtensionType(parsed as Record<string, unknown>);
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
      return correctExtensionType({
        id: parsed,
        type: 'string',
        stability: 'development',
        brief: `Agent-discovered attribute: ${parsed}`,
      });
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Append type information from agent-declared schemaExtensions to the resolved schema
 * so SCH-003 (its auto-fix and its check) can see the types of attributes the agent
 * declared but runPerAttemptAutoRegistration intentionally skipped.
 *
 * Each schemaExtension is a YAML string with fields like id, type, brief, or a bare
 * dotted ID. Only attribute extensions (type !== 'span') are included. The id field
 * maps to the attribute name used in setAttribute() calls.
 */
export function appendDeclaredExtensionTypes(
  schema: object,
  schemaExtensions: string[],
): object {
  if (schemaExtensions.length === 0) return schema;

  const typedAttrs: Array<{ name: string; type: string }> = [];
  for (const ext of schemaExtensions) {
    const parsed = parseExtension(ext);
    if (!parsed) continue;
    const id = parsed['id'];
    const type = parsed['type'];
    if (typeof id !== 'string' || typeof type !== 'string') continue;
    if (type === 'span') continue;
    typedAttrs.push({ name: id, type });
  }

  if (typedAttrs.length === 0) return schema;

  const existing = (schema as Record<string, unknown>).groups;
  const existingGroups = Array.isArray(existing) ? existing : [];
  return {
    ...schema,
    groups: [
      ...existingGroups,
      {
        id: 'spiny_orb_declared_extension_types',
        type: 'attribute_group',
        brief: 'Type info from agent-declared schema extensions for SCH-003',
        attributes: typedAttrs,
      },
    ],
  };
}

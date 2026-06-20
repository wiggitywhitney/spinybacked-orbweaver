// ABOUTME: Tests for SCH-003 sequencing gap — fixAttributeTypeCoercions must receive type info
// ABOUTME: from agent-declared schemaExtensions, not just the base registry schema.

import { describe, it, expect } from 'vitest';
import { fixAttributeTypeCoercions } from '../../src/languages/javascript/rules/sch003.ts';
import { appendDeclaredExtensionTypes } from '../../src/fix-loop/instrument-with-retry.ts';

describe('SCH-003 sequencing gap: agent-declared string-typed key + numeric expression', () => {
  const code = [
    'const { trace } = require("@opentelemetry/api");',
    'const tracer = trace.getTracer("svc");',
    'tracer.startActiveSpan("work", (span) => {',
    '  try {',
    '    span.setAttribute("myapp.diff_size", result.length);',
    '  } finally { span.end(); }',
    '});',
  ].join('\n');

  it('wraps numeric expression in String() when agent-declared extension type is string', () => {
    // Reproduces the sequencing gap from issue #985.
    // runPerAttemptAutoRegistration skips keys in schemaExtensions, so they reach
    // appendAttributeExtensionsToSchema as { name } only (no type field).
    // appendDeclaredExtensionTypes parses schemaExtensions YAML and injects { name, type }
    // entries so fixAttributeTypeCoercions can coerce the numeric value to String().
    const schemaWithoutType = {
      groups: [{
        id: 'spiny_orb_auto_registration_extensions',
        type: 'attribute_group',
        brief: 'Auto-registered keys',
        attributes: [{ name: 'myapp.diff_size' }],
      }],
    };
    // schemaExtensions YAML as the agent would declare it
    const schemaExtensions = ['id: myapp.diff_size\ntype: string\nbrief: Size of diff in lines'];

    const enrichedSchema = appendDeclaredExtensionTypes(schemaWithoutType, schemaExtensions);
    const result = fixAttributeTypeCoercions(code, enrichedSchema);
    expect(result).toContain('String(result.length)');
  });

  it('wraps numeric expression in String() when schema includes type from schemaExtensions', () => {
    // Verifies that including type info in the schema makes the fix work correctly.
    // This is the target state after the fix is applied.
    const schemaWithType = {
      groups: [{
        id: 'spiny_orb_auto_registration_extensions',
        type: 'attribute_group',
        brief: 'Auto-registered keys with type info from schemaExtensions',
        attributes: [{ name: 'myapp.diff_size', type: 'string' }],
      }],
    };

    const result = fixAttributeTypeCoercions(code, schemaWithType);
    expect(result).toContain('String(result.length)');
  });

  it('leaves code unchanged when schema has no matching attribute', () => {
    const schemaEmpty = { groups: [] };

    const result = fixAttributeTypeCoercions(code, schemaEmpty);
    expect(result).toBe(code);
  });
});

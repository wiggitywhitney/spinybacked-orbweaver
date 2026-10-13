// ABOUTME: Tests that bare-ID count extensions are typed int before SCH-003's coercion runs,
// ABOUTME: and that SCH-003 flags an agent-written String() on a key the agent declared as a count.

import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse } from 'yaml';
import { fixAttributeTypeCoercions, sch003Rule } from '../../src/languages/javascript/rules/sch003.ts';
import { appendDeclaredExtensionTypes } from '../../src/fix-loop/instrument-with-retry.ts';
import { parseExtension, writeSchemaExtensions } from '../../src/coordinator/schema-extensions.ts';
import type { CheckResult, ValidationConfig } from '../../src/validation/types.ts';

function spanCode(setAttributeLine: string): string {
  return [
    'const { trace } = require("@opentelemetry/api");',
    'const tracer = trace.getTracer("svc");',
    'tracer.startActiveSpan("work", (span) => {',
    '  try {',
    `    ${setAttributeLine}`,
    '  } finally { span.end(); }',
    '});',
  ].join('\n');
}

describe('bare-ID extension types are corrected before coercion', () => {
  it('parseExtension types a bare-ID *_count or *.count key as int', () => {
    expect(parseExtension('my_service.plugin.enabled_count')?.type).toBe('int');
    expect(parseExtension('my_service.queue.count')?.type).toBe('int');
  });

  it('parseExtension types a bare-ID is_/has_/should_ key as boolean', () => {
    expect(parseExtension('my_service.run.is_dry_run')?.type).toBe('boolean');
  });

  it('parseExtension leaves other bare-ID keys as string', () => {
    expect(parseExtension('my_service.user.region')?.type).toBe('string');
  });

  it('does not wrap a .length value in String() for a bare-ID *_count extension', () => {
    const schema = appendDeclaredExtensionTypes({ groups: [] }, ['my_service.plugin.enabled_count']);
    const result = fixAttributeTypeCoercions(
      spanCode('span.setAttribute("my_service.plugin.enabled_count", plugins.length);'),
      schema,
    );
    expect(result).toContain('span.setAttribute("my_service.plugin.enabled_count", plugins.length);');
    expect(result).not.toContain('String(plugins.length)');
  });

  it('still wraps when the agent explicitly declares a non-count key as string', () => {
    const schema = appendDeclaredExtensionTypes(
      { groups: [] },
      ['id: my_service.diff_size\ntype: string\nbrief: Size of diff in lines'],
    );
    const result = fixAttributeTypeCoercions(
      spanCode('span.setAttribute("my_service.diff_size", result.length);'),
      schema,
    );
    expect(result).toContain('String(result.length)');
  });
});

describe('registry writes never type a count extension as string', () => {
  it('writes bare-ID and explicitly string-typed *_count extensions as int', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'spiny-orb-count-types-'));
    try {
      await writeFile(join(dir, 'registry_manifest.yaml'), 'name: my_service\n', 'utf-8');
      await writeSchemaExtensions(dir, [
        'my_service.plugin.enabled_count',
        'id: my_service.queue.items_count\ntype: string\nbrief: Items in the queue',
      ]);
      const written = parse(await readFile(join(dir, 'agent-extensions.yaml'), 'utf-8'));
      const attrs = written.groups.flatMap((g: { attributes?: Array<{ id: string; type: string }> }) => g.attributes ?? []);
      const countAttrs = attrs.filter((a: { id: string }) => a.id.endsWith('_count'));
      expect(countAttrs).toHaveLength(2);
      for (const a of countAttrs) expect(a.type).toBe('int');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('SCH-003 sees agent-declared extension types', () => {
  it('flags String(x.length) on a key the agent declared as a count, even when the base schema lacks it', () => {
    const config = {
      resolvedSchema: { groups: [] },
      declaredSpanExtensions: ['my_service.journal.reflections_count'],
    } as unknown as ValidationConfig;
    const results = sch003Rule.check({
      instrumentedCode: spanCode('span.setAttribute("my_service.journal.reflections_count", String(reflections.length));'),
      originalCode: '',
      filePath: 'journal-manager.js',
      config,
    } as Parameters<typeof sch003Rule.check>[0]);
    // sch003Rule.check is synchronous and returns CheckResult[] directly.
    const failures = (results as CheckResult[]).filter(r => !r.passed);
    expect(failures).toHaveLength(1);
    expect(failures[0].blocking).toBe(true);
    expect(failures[0].message).toContain('my_service.journal.reflections_count');
  });

  it('flags a boolean literal on a key the agent declared as string', () => {
    const config = {
      resolvedSchema: { groups: [] },
      declaredSpanExtensions: ['id: my_service.journal.summary_saved\ntype: string\nbrief: Whether the summary was saved'],
    } as unknown as ValidationConfig;
    const results = sch003Rule.check({
      instrumentedCode: spanCode('span.setAttribute("my_service.journal.summary_saved", true);'),
      originalCode: '',
      filePath: 'summary-manager.js',
      config,
    } as Parameters<typeof sch003Rule.check>[0]);
    const failures = (results as CheckResult[]).filter(r => !r.passed);
    expect(failures).toHaveLength(1);
    expect(failures[0].blocking).toBe(true);
  });
});

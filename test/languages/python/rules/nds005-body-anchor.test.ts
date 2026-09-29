// ABOUTME: Tests for extractBodyAnchor in the Python NDS-005 check — which statement anchors a try block.
// ABOUTME: Verifies OTel-only statements are skipped without skipping compound statements that merely contain OTel calls.

import { describe, it, expect } from 'vitest';
import { parsePython } from '../../../../src/languages/python/ast.ts';
import { extractBodyAnchor } from '../../../../src/languages/python/rules/nds005.ts';

/** Anchor of the first (outermost) try statement in `source`. */
function anchorOfFirstTry(source: string): string {
  const tree = parsePython(source);
  try {
    const tryNode = tree.rootNode.descendantsOfType('try_statement')[0];
    if (tryNode === undefined || tryNode === null) throw new Error('test source has no try statement');
    return extractBodyAnchor(tryNode);
  } finally {
    tree.delete();
  }
}

describe('extractBodyAnchor (Python NDS-005)', () => {
  it('anchors on the first statement of an uninstrumented try body', () => {
    const source = [
      'def load(path):',
      '    try:',
      '        result = read(path)',
      '    except ValueError:',
      '        pass',
      '',
    ].join('\n');

    expect(anchorOfFirstTry(source)).toBe('result = read(path)');
  });

  it('skips a leading OTel-only expression statement', () => {
    const source = [
      'def load(path):',
      '    try:',
      '        span.set_attribute("path", path)',
      '        result = read(path)',
      '    except ValueError:',
      '        pass',
      '',
    ].join('\n');

    expect(anchorOfFirstTry(source)).toBe('result = read(path)');
  });

  it('looks inside a span-opening with block to find the original first statement', () => {
    const source = [
      'def load(path):',
      '    try:',
      '        with tracer.start_as_current_span("load") as span:',
      '            result = read(path)',
      '    except ValueError:',
      '        pass',
      '',
    ].join('\n');

    expect(anchorOfFirstTry(source)).toBe('result = read(path)');
  });

  it('does not skip a compound statement that only contains an OTel call in its body', () => {
    const source = [
      'def load(path):',
      '    try:',
      '        if ready:',
      '            span.set_attribute("ready", True)',
      '        result = read(path)',
      '    except ValueError:',
      '        pass',
      '',
    ].join('\n');

    expect(anchorOfFirstTry(source)).toBe('if ready:');
  });

  it('recurses into a nested try that closes a manually ended span', () => {
    const source = [
      'def load(path):',
      '    try:',
      '        span = tracer.start_span("load")',
      '        try:',
      '            result = read(path)',
      '        finally:',
      '            span.end()',
      '    except ValueError:',
      '        pass',
      '',
    ].join('\n');

    expect(anchorOfFirstTry(source)).toBe('result = read(path)');
  });

  it('returns an empty anchor when the try body holds only OTel statements', () => {
    const source = [
      'def load(path):',
      '    try:',
      '        span.set_attribute("path", path)',
      '    except ValueError:',
      '        pass',
      '',
    ].join('\n');

    expect(anchorOfFirstTry(source)).toBe('');
  });
});

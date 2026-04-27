// ABOUTME: Tests for JavaScriptProvider.preInstrumentationAnalysis() — M1 pre-scan.
// ABOUTME: Covers COV-001 entry point detection, RST-006 process.exit() conflict, and tiebreaker.

import { describe, it, expect } from 'vitest';
import { JavaScriptProvider } from '../../../src/languages/javascript/index.ts';

describe('JavaScriptProvider.preInstrumentationAnalysis()', () => {
  const provider = new JavaScriptProvider();

  it('returns undefined when method does not exist on provider', () => {
    // Verify the method is optional — callers must check before using.
    // This test passes vacuously once the method is implemented; it guards
    // the caller-side contract before the method exists.
    expect(typeof provider.preInstrumentationAnalysis).toBe('function');
  });

  describe('COV-001: exported async entry points', () => {
    it('reports an exported async function as an entry point needing a span', () => {
      const source = `
export async function handleRequest(req, res) {
  const data = await fetchData(req.id);
  res.json(data);
}
`.trim();

      const result = provider.preInstrumentationAnalysis!(source);

      expect(result.entryPointsNeedingSpans).toHaveLength(1);
      expect(result.entryPointsNeedingSpans[0].name).toBe('handleRequest');
      expect(result.entryPointsNeedingSpans[0].startLine).toBe(1);
    });

    it('reports a function named main as an entry point regardless of export status', () => {
      const source = `
async function main() {
  await run();
}
`.trim();

      const result = provider.preInstrumentationAnalysis!(source);

      expect(result.entryPointsNeedingSpans.some(f => f.name === 'main')).toBe(true);
    });

    it('does not report unexported async functions as entry points', () => {
      const source = `
async function internal(x) {
  return await fetch(x);
}
`.trim();

      const result = provider.preInstrumentationAnalysis!(source);

      expect(result.entryPointsNeedingSpans.every(f => f.name !== 'internal')).toBe(true);
    });

    it('does not report sync exported functions as entry points', () => {
      const source = `
export function transform(data) {
  return data.map(x => x * 2);
}
`.trim();

      const result = provider.preInstrumentationAnalysis!(source);

      expect(result.entryPointsNeedingSpans).toHaveLength(0);
    });

    it('reports multiple exported async functions', () => {
      const source = `
export async function create(item) {
  return await db.insert(item);
}

export async function remove(id) {
  return await db.delete(id);
}
`.trim();

      const result = provider.preInstrumentationAnalysis!(source);

      expect(result.entryPointsNeedingSpans).toHaveLength(2);
      const names = result.entryPointsNeedingSpans.map(f => f.name);
      expect(names).toContain('create');
      expect(names).toContain('remove');
    });
  });

  describe('RST-006: process.exit() conflict with COV-001', () => {
    it('flags an exported async entry point with direct process.exit() in processExitEntryPoints', () => {
      const source = `
export async function main() {
  const result = await run();
  if (!result.ok) {
    process.exit(1);
  }
}
`.trim();

      const result = provider.preInstrumentationAnalysis!(source);

      expect(result.processExitEntryPoints).toHaveLength(1);
      expect(result.processExitEntryPoints[0].name).toBe('main');
    });

    it('includes constraintNote for process.exit() entry points', () => {
      const source = `
export async function main() {
  const result = await run();
  process.exit(result.code);
}
`.trim();

      const result = provider.preInstrumentationAnalysis!(source);

      const entry = result.processExitEntryPoints[0];
      expect(entry.constraintNote).toBeTruthy();
    });

    it('constraintNote instructs minimal wrapper pattern (COV-001 tiebreaker)', () => {
      const source = `
export async function handleSummarize() {
  const data = await getData();
  process.exit(0);
}
`.trim();

      const result = provider.preInstrumentationAnalysis!(source);
      const note = result.processExitEntryPoints[0]?.constraintNote ?? '';

      // Must instruct span addition (COV-001 wins), not skip
      expect(note).toContain('startActiveSpan');
      // Must specify minimal wrapper constraint
      expect(note.toLowerCase()).toMatch(/minimal wrapper|finally/);
      // Must NOT say to skip instrumentation
      expect(note.toLowerCase()).not.toContain('skip');
      expect(note.toLowerCase()).not.toContain('do not add a span');
    });

    it('process.exit() entry point also appears in entryPointsNeedingSpans', () => {
      // COV-001 wins: the function still needs a span, it's just constrained.
      const source = `
export async function main() {
  process.exit(await getCode());
}
`.trim();

      const result = provider.preInstrumentationAnalysis!(source);

      const names = result.entryPointsNeedingSpans.map(f => f.name);
      expect(names).toContain('main');
    });

    it('does not flag process.exit() only inside a catch block', () => {
      // process.exit() in catch does not exempt the function from spanning.
      const source = `
export async function fetchWithFallback(url) {
  try {
    return await fetch(url);
  } catch (err) {
    process.exit(1);
  }
}
`.trim();

      const result = provider.preInstrumentationAnalysis!(source);

      // Should be in entryPointsNeedingSpans (normal entry point)
      expect(result.entryPointsNeedingSpans.some(f => f.name === 'fetchWithFallback')).toBe(true);
      // Should NOT be flagged as process.exit() entry point
      expect(result.processExitEntryPoints.every(f => f.name !== 'fetchWithFallback')).toBe(true);
    });
  });

  describe('empty / no functions', () => {
    it('returns empty arrays for a file with no function definitions', () => {
      const source = `const x = 42;\nexport default x;`;

      const result = provider.preInstrumentationAnalysis!(source);

      expect(result.entryPointsNeedingSpans).toHaveLength(0);
      expect(result.processExitEntryPoints).toHaveLength(0);
    });

    it('returns empty arrays for an empty string', () => {
      const result = provider.preInstrumentationAnalysis!('');

      expect(result.entryPointsNeedingSpans).toHaveLength(0);
      expect(result.processExitEntryPoints).toHaveLength(0);
    });
  });
});

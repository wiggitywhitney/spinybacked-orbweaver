// ABOUTME: Tests for Python-specific prompt sections and instrumentation examples.
// ABOUTME: Verifies constraint guidance is internally consistent with the examples it accompanies.

import { describe, it, expect } from 'vitest';
import { getSystemPromptSections, getInstrumentationExamples } from '../../../src/languages/python/prompt.ts';

describe('Python instrumentation prompt constraints', () => {
  it('permits importing Status/StatusCode from opentelemetry.trace, matching the error-handling examples', () => {
    const sections = getSystemPromptSections();
    const examples = getInstrumentationExamples();

    // The constraint text must not contradict an import the examples actually use.
    const usesStatusImport = examples.some(ex => ex.after.includes('from opentelemetry.trace import Status, StatusCode'));
    expect(usesStatusImport).toBe(true);
    expect(sections.constraints).toContain('from opentelemetry.trace import Status, StatusCode');
  });

  it('does not teach recording a raw filesystem path as a span attribute', () => {
    const examples = getInstrumentationExamples();
    for (const example of examples) {
      expect(example.after).not.toMatch(/set_attribute\(\s*["'][\w.]*path["']\s*,\s*path\s*\)/);
    }
  });
});

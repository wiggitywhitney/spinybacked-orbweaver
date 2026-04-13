// ABOUTME: Tests for JavaScript-specific prompt sections.
// ABOUTME: Verifies constraint guidance is present and correct.

import { describe, it, expect } from 'vitest';
import { getSystemPromptSections } from '../../../src/languages/javascript/prompt.ts';

describe('JavaScript instrumentation prompt constraints', () => {
  it('includes template literal preservation constraint', () => {
    const sections = getSystemPromptSections();
    expect(sections.constraints).toContain('Do not modify the content of existing template literals.');
  });

  it('directs agent to add setAttribute after the assignment, not inside the template expression', () => {
    const sections = getSystemPromptSections();
    expect(sections.constraints).toContain('span.setAttribute');
    expect(sections.constraints).toMatch(/after.*template literal|template literal.*after/i);
    expect(sections.constraints).toContain('never inline a span context expression within the template expression itself');
  });
});

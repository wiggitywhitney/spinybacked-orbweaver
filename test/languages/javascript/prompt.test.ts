// ABOUTME: Tests for JavaScript-specific prompt sections.
// ABOUTME: Verifies constraint guidance is present and correct.

import { describe, it, expect } from 'vitest';
import { getSystemPromptSections } from '../../../src/languages/javascript/prompt.ts';

describe('JavaScript instrumentation prompt constraints', () => {
  it('includes template literal preservation constraint', () => {
    const sections = getSystemPromptSections();
    // Must mention template literals and that they should not be modified
    expect(sections.constraints).toContain('template literal');
  });

  it('directs agent to add setAttribute after the assignment, not inside the template expression', () => {
    const sections = getSystemPromptSections();
    // Must explain the correct pattern: setAttribute after the variable assignment
    expect(sections.constraints).toContain('span.setAttribute');
    expect(sections.constraints).toMatch(/after.*template literal|template literal.*after/i);
  });
});

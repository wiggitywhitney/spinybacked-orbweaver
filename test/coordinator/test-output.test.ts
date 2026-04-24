// ABOUTME: Unit tests for test subprocess output formatting helpers.
// ABOUTME: Covers inline display (short output), line-boundary truncation (long output), and empty input.

import { describe, it, expect } from 'vitest';
import { formatTestOutput } from '../../src/coordinator/test-output.ts';

describe('formatTestOutput', () => {
  it('returns full output unchanged when lines <= maxLines', () => {
    const output = 'line 1\nline 2\nline 3';
    const result = formatTestOutput(output, 50);
    expect(result.display).toBe(output);
    expect(result.truncated).toBe(false);
    expect(result.totalLines).toBe(3);
  });

  it('returns full output when line count exactly equals maxLines', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`);
    const output = lines.join('\n');
    const result = formatTestOutput(output, 50);
    expect(result.truncated).toBe(false);
    expect(result.totalLines).toBe(50);
  });

  it('truncates at line boundary when lines > maxLines', () => {
    const lines = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`);
    const output = lines.join('\n');
    const result = formatTestOutput(output, 50);
    expect(result.truncated).toBe(true);
    expect(result.totalLines).toBe(60);
    // Display should contain the first 50 lines
    expect(result.display).toContain('line 50');
    expect(result.display).not.toContain('line 51');
    // Should have truncation marker
    expect(result.display).toContain('... 10 more lines');
    expect(result.display).toContain('log file');
  });

  it('uses singular "line" when exactly 1 line is truncated', () => {
    const lines = Array.from({ length: 51 }, (_, i) => `line ${i + 1}`);
    const output = lines.join('\n');
    const result = formatTestOutput(output, 50);
    expect(result.display).toContain('... 1 more line ');
    expect(result.display).not.toContain('lines');
  });

  it('handles empty output', () => {
    const result = formatTestOutput('', 50);
    expect(result.display).toBe('');
    expect(result.truncated).toBe(false);
    expect(result.totalLines).toBe(1);
  });

  it('uses default maxLines of 50 when not specified', () => {
    const lines = Array.from({ length: 55 }, (_, i) => `line ${i + 1}`);
    const output = lines.join('\n');
    const result = formatTestOutput(output);
    expect(result.truncated).toBe(true);
    expect(result.display).toContain('... 5 more lines');
  });

  it('respects custom maxLines', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`);
    const output = lines.join('\n');
    const result = formatTestOutput(output, 3);
    expect(result.truncated).toBe(true);
    expect(result.display).toContain('line 3');
    expect(result.display).not.toContain('line 4');
    expect(result.display).toContain('... 7 more lines');
  });
});

import { describe, it, expect } from 'vitest';

describe('project setup', () => {
  it('confirms TypeScript with erasableSyntaxOnly works', () => {
    const value: string = 'spiny-orb';
    expect(value).toBe('spiny-orb');
  });
});

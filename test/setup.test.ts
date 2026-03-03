import { describe, it, expect } from 'vitest';

describe('project setup', () => {
  it('confirms TypeScript with erasableSyntaxOnly works', () => {
    const value: string = 'orbweaver';
    expect(value).toBe('orbweaver');
  });
});

// ABOUTME: Middle fixture file for dep-graph tests — imports from local ./c and external node:fs.
import { readFileSync } from 'node:fs';
import { cFunc } from './c.ts';

export function bFunc(path: string): string {
  const content = readFileSync(path, 'utf8');
  return cFunc(content, path);
}

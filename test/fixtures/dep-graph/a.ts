// ABOUTME: Top-level fixture file for dep-graph tests — imports from local ./b and external ts-morph.
import type { Project } from 'ts-morph';
import { bFunc } from './b.ts';

export function aFunc(path: string, _project: Project): string {
  return bFunc(path);
}

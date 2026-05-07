// ABOUTME: Leaf fixture file for dep-graph tests — no local imports, only external.
import { join } from 'node:path';

export function cFunc(a: string, b: string): string {
  return join(a, b);
}

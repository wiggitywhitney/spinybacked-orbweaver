// ABOUTME: Vitest global setup — patches PATH to include ~/.cargo/bin for weaver.
// ABOUTME: Fixes weaver ENOENT errors when tests run in environments with a stripped PATH (e.g. vals exec).

import { homedir } from 'node:os';
import { join } from 'node:path';

export default function setup() {
  const cargoBin = join(homedir(), '.cargo', 'bin');
  const currentPath = process.env.PATH ?? '';
  if (!currentPath.includes(cargoBin)) {
    process.env.PATH = `${cargoBin}:${currentPath}`;
  }
}

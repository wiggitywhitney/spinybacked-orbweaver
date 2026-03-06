// ABOUTME: Production dependency factory for the init handler.
// ABOUTME: Provides real filesystem, process, and network implementations.

import { readFile, access, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { createInterface } from 'node:readline';
import { statSync } from 'node:fs';
import type { InitDeps } from './init-handler.ts';

/** Common Weaver schema directory names. */
const SCHEMA_DIR_CANDIDATES = ['semconv', 'schema', 'semantic-conventions'];

/**
 * Check if a TCP port is available by attempting to bind to it.
 *
 * @param port - Port number to check
 * @returns true if the port is available
 */
function checkPortAvailability(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => {
      resolve(false);
    });
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, '127.0.0.1');
  });
}

/**
 * Find the first existing file matching any of the candidate patterns.
 *
 * @param projectDir - Project root directory
 * @param patterns - Relative file paths to check
 * @returns Array of matching paths (relative to projectDir)
 */
function findMatchingFiles(projectDir: string, patterns: string[]): string[] {
  const found: string[] = [];
  for (const pattern of patterns) {
    try {
      const fullPath = join(projectDir, pattern);
      statSync(fullPath);
      found.push(pattern);
    } catch {
      // File doesn't exist
    }
  }
  return found;
}

/**
 * Find a Weaver schema directory in the project.
 *
 * @param projectDir - Project root directory
 * @returns Relative path to schema directory, or null if not found
 */
function findSchemaDirInProject(projectDir: string): string | null {
  for (const candidate of SCHEMA_DIR_CANDIDATES) {
    try {
      const fullPath = join(projectDir, candidate);
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        return candidate;
      }
    } catch {
      // Directory doesn't exist
    }
  }
  return null;
}

/**
 * Prompt the user for input via stdin/stdout.
 *
 * @param question - Question to display
 * @returns User's response
 */
function promptUser(question: string): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

/**
 * Create production dependencies for the init handler.
 *
 * @param projectDir - Project root directory
 * @returns InitDeps with real implementations
 */
function createProductionDeps(projectDir: string): InitDeps {
  return {
    readFile: (path: string) => readFile(path, 'utf-8'),
    access: (path: string) => access(path),
    writeFile: (path: string, content: string) => writeFile(path, content, 'utf-8'),
    execFileSync: (cmd: string, args: string[], opts?: object) =>
      execFileSync(cmd, args, { ...opts, encoding: 'buffer' }) as unknown as Buffer,
    globSync: (patterns: string[]) => findMatchingFiles(projectDir, patterns),
    findSchemaDir: (dir: string) => findSchemaDirInProject(dir),
    prompt: promptUser,
    stderr: (msg: string) => console.error(msg),
    checkPort: checkPortAvailability,
  };
}

export { createProductionDeps };

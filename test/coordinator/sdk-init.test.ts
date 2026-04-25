// ABOUTME: Unit tests for the SDK init file writing module.
// ABOUTME: Covers NodeSDK pattern detection, instrumentation appending, import insertion, and fallback file writing.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFile, readFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { LibraryRequirement } from '../../src/agent/schema.ts';
import { updateSdkInitFile } from '../../src/coordinator/sdk-init.ts';

let testDir: string;

beforeEach(async () => {
  testDir = join(tmpdir(), `sdk-init-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(testDir, { recursive: true });
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

/** Helper to create an SDK init file with content. */
async function createSdkInitFile(content: string): Promise<string> {
  const filePath = join(testDir, 'setup.js');
  await writeFile(filePath, content, 'utf-8');
  return filePath;
}

/** Build a LibraryRequirement for testing. */
function makeLibrary(pkg: string, importName: string): LibraryRequirement {
  return { package: pkg, importName };
}

describe('updateSdkInitFile', () => {
  describe('NodeSDK pattern detection with ES imports', () => {
    it('appends new instrumentations when array contains a call expression like getNodeAutoInstrumentations()', async () => {
      // Exact SDK_INIT_CONTENT used in the coordinator acceptance gate test
      await writeFile(join(testDir, 'package.json'), JSON.stringify({ type: 'module' }), 'utf-8');
      const sdkFile = await createSdkInitFile(
        `import { NodeSDK } from '@opentelemetry/sdk-node';\n` +
        `import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';\n\n` +
        `const sdk = new NodeSDK({\n` +
        `  instrumentations: [\n` +
        `    getNodeAutoInstrumentations(),\n` +
        `  ],\n` +
        `});\n\n` +
        `sdk.start();\n`,
      );

      const libraries: LibraryRequirement[] = [
        makeLibrary('@opentelemetry/instrumentation-express', 'ExpressInstrumentation'),
      ];

      const result = await updateSdkInitFile(sdkFile, libraries, testDir);

      expect(result.updated).toBe(true);
      expect(result.fallbackWritten).toBe(false);

      const content = await readFile(sdkFile, 'utf-8');
      expect(content).toContain('ExpressInstrumentation');
      expect(content).toContain('@opentelemetry/instrumentation-express');
      // Original call expression must be preserved
      expect(content).toContain('getNodeAutoInstrumentations()');
    });

    it('appends new instrumentations to an existing NodeSDK instrumentations array', async () => {
      const sdkFile = await createSdkInitFile(`
import { NodeSDK } from '@opentelemetry/sdk-node';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';

const sdk = new NodeSDK({
  instrumentations: [
    new HttpInstrumentation(),
  ],
});

sdk.start();
`);

      const libraries: LibraryRequirement[] = [
        makeLibrary('@opentelemetry/instrumentation-pg', 'PgInstrumentation'),
      ];

      const result = await updateSdkInitFile(sdkFile, libraries);

      expect(result.updated).toBe(true);
      expect(result.fallbackWritten).toBe(false);

      const content = await readFile(sdkFile, 'utf-8');
      expect(content).toContain("import { PgInstrumentation } from '@opentelemetry/instrumentation-pg'");
      expect(content).toContain('new PgInstrumentation()');
      // Original entries preserved
      expect(content).toContain('new HttpInstrumentation()');
    });

    it('appends multiple new instrumentations', async () => {
      const sdkFile = await createSdkInitFile(`
import { NodeSDK } from '@opentelemetry/sdk-node';

const sdk = new NodeSDK({
  instrumentations: [],
});

sdk.start();
`);

      const libraries: LibraryRequirement[] = [
        makeLibrary('@opentelemetry/instrumentation-http', 'HttpInstrumentation'),
        makeLibrary('@opentelemetry/instrumentation-pg', 'PgInstrumentation'),
        makeLibrary('@opentelemetry/instrumentation-redis', 'RedisInstrumentation'),
      ];

      const result = await updateSdkInitFile(sdkFile, libraries);

      expect(result.updated).toBe(true);

      const content = await readFile(sdkFile, 'utf-8');
      expect(content).toContain('new HttpInstrumentation()');
      expect(content).toContain('new PgInstrumentation()');
      expect(content).toContain('new RedisInstrumentation()');
    });

    it('skips libraries already present in the instrumentations array', async () => {
      const sdkFile = await createSdkInitFile(`
import { NodeSDK } from '@opentelemetry/sdk-node';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';

const sdk = new NodeSDK({
  instrumentations: [
    new HttpInstrumentation(),
  ],
});

sdk.start();
`);

      const libraries: LibraryRequirement[] = [
        makeLibrary('@opentelemetry/instrumentation-http', 'HttpInstrumentation'),
        makeLibrary('@opentelemetry/instrumentation-pg', 'PgInstrumentation'),
      ];

      const result = await updateSdkInitFile(sdkFile, libraries);

      expect(result.updated).toBe(true);

      const content = await readFile(sdkFile, 'utf-8');
      // PgInstrumentation added
      expect(content).toContain('new PgInstrumentation()');
      // HttpInstrumentation not duplicated — count occurrences of 'new HttpInstrumentation()'
      const matches = content.match(/new HttpInstrumentation\(\)/g);
      expect(matches).toHaveLength(1);
    });
  });

  describe('NodeSDK pattern detection with CommonJS require', () => {
    it('detects and updates NodeSDK pattern with require()', async () => {
      const sdkFile = await createSdkInitFile(`
const { NodeSDK } = require('@opentelemetry/sdk-node');
const { HttpInstrumentation } = require('@opentelemetry/instrumentation-http');

const sdk = new NodeSDK({
  instrumentations: [
    new HttpInstrumentation(),
  ],
});

sdk.start();
`);

      const libraries: LibraryRequirement[] = [
        makeLibrary('@opentelemetry/instrumentation-pg', 'PgInstrumentation'),
      ];

      const result = await updateSdkInitFile(sdkFile, libraries);

      expect(result.updated).toBe(true);
      expect(result.fallbackWritten).toBe(false);

      const content = await readFile(sdkFile, 'utf-8');
      // CJS file gets CJS-style require
      expect(content).toContain("const { PgInstrumentation } = require('@opentelemetry/instrumentation-pg')");
      expect(content).toContain('new PgInstrumentation()');
    });
  });

  describe('fallback behavior', () => {
    it('writes fallback file when no NodeSDK pattern found', async () => {
      const sdkFile = await createSdkInitFile(`
// Custom telemetry setup without NodeSDK
const instrumentations = buildInstrumentations();
startTelemetry(instrumentations);
`);

      const libraries: LibraryRequirement[] = [
        makeLibrary('@opentelemetry/instrumentation-http', 'HttpInstrumentation'),
        makeLibrary('@opentelemetry/instrumentation-pg', 'PgInstrumentation'),
      ];

      const result = await updateSdkInitFile(sdkFile, libraries);

      expect(result.updated).toBe(false);
      expect(result.fallbackWritten).toBe(true);
      expect(result.fallbackPath).toBeDefined();

      const fallbackContent = await readFile(result.fallbackPath!, 'utf-8');
      expect(fallbackContent).toContain('HttpInstrumentation');
      expect(fallbackContent).toContain('PgInstrumentation');
      expect(fallbackContent).toContain('@opentelemetry/instrumentation-http');
      expect(fallbackContent).toContain('@opentelemetry/instrumentation-pg');
    });

    it('writes fallback when instrumentations property uses non-array pattern', async () => {
      const sdkFile = await createSdkInitFile(`
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getInstrumentations } from './instrumentations';

const sdk = new NodeSDK({
  instrumentations: getInstrumentations(),
});

sdk.start();
`);

      const libraries: LibraryRequirement[] = [
        makeLibrary('@opentelemetry/instrumentation-http', 'HttpInstrumentation'),
      ];

      const result = await updateSdkInitFile(sdkFile, libraries);

      expect(result.updated).toBe(false);
      expect(result.fallbackWritten).toBe(true);
    });

    it('writes fallback when instrumentations use spread operator', async () => {
      const sdkFile = await createSdkInitFile(`
import { NodeSDK } from '@opentelemetry/sdk-node';
import { baseInstrumentations } from './base';

const sdk = new NodeSDK({
  instrumentations: [...baseInstrumentations],
});

sdk.start();
`);

      const libraries: LibraryRequirement[] = [
        makeLibrary('@opentelemetry/instrumentation-http', 'HttpInstrumentation'),
      ];

      const result = await updateSdkInitFile(sdkFile, libraries);

      expect(result.updated).toBe(false);
      expect(result.fallbackWritten).toBe(true);
    });

    it('writes ESM fallback when source file is ESM', async () => {
      const sdkFile = await createSdkInitFile(`
import { startTelemetry } from './telemetry';

// Custom setup without NodeSDK
startTelemetry();
`);

      const libraries: LibraryRequirement[] = [
        makeLibrary('@opentelemetry/instrumentation-http', 'HttpInstrumentation'),
      ];

      const result = await updateSdkInitFile(sdkFile, libraries);

      expect(result.fallbackWritten).toBe(true);
      const fallbackContent = await readFile(result.fallbackPath!, 'utf-8');
      // Should use ESM import/export syntax
      expect(fallbackContent).toContain("import { HttpInstrumentation } from '@opentelemetry/instrumentation-http'");
      expect(fallbackContent).toContain('export');
      // Should NOT use require/module.exports
      expect(fallbackContent).not.toContain('require(');
      expect(fallbackContent).not.toContain('module.exports');
    });

    it('returns warning message for fallback', async () => {
      const sdkFile = await createSdkInitFile(`
// No NodeSDK pattern
console.log('setup');
`);

      const libraries: LibraryRequirement[] = [
        makeLibrary('@opentelemetry/instrumentation-http', 'HttpInstrumentation'),
      ];

      const result = await updateSdkInitFile(sdkFile, libraries);

      expect(result.warning).toBeDefined();
      expect(result.warning).toContain('spiny-orb-instrumentations.js');
    });
  });

  describe('package.json type detection', () => {
    it('generates ESM imports when package.json has "type": "module" even if file has no imports', async () => {
      // Write a package.json with "type": "module" in the test dir
      await writeFile(join(testDir, 'package.json'), JSON.stringify({ type: 'module' }), 'utf-8');

      // SDK init file has no import/export keywords — isEsmFile() would return false
      const sdkFile = await createSdkInitFile(`
const { NodeSDK } = require('@opentelemetry/sdk-node');

const sdk = new NodeSDK({
  instrumentations: [],
});

sdk.start();
`);

      const libraries: LibraryRequirement[] = [
        makeLibrary('@opentelemetry/instrumentation-pg', 'PgInstrumentation'),
      ];

      const result = await updateSdkInitFile(sdkFile, libraries, testDir);

      expect(result.updated).toBe(true);

      const content = await readFile(sdkFile, 'utf-8');
      // Should use ESM import, not CJS require
      expect(content).toContain("import { PgInstrumentation } from '@opentelemetry/instrumentation-pg'");
      expect(content).not.toContain("require('@opentelemetry/instrumentation-pg')");
    });

    it('generates CJS require when package.json has no "type" field', async () => {
      await writeFile(join(testDir, 'package.json'), JSON.stringify({ name: 'test' }), 'utf-8');

      const sdkFile = await createSdkInitFile(`
const { NodeSDK } = require('@opentelemetry/sdk-node');

const sdk = new NodeSDK({
  instrumentations: [],
});

sdk.start();
`);

      const libraries: LibraryRequirement[] = [
        makeLibrary('@opentelemetry/instrumentation-pg', 'PgInstrumentation'),
      ];

      const result = await updateSdkInitFile(sdkFile, libraries, testDir);

      expect(result.updated).toBe(true);

      const content = await readFile(sdkFile, 'utf-8');
      // Should use CJS require
      expect(content).toContain("require('@opentelemetry/instrumentation-pg')");
      expect(content).not.toContain("import { PgInstrumentation }");
    });

    it('generates CJS require when package.json has explicit "type": "commonjs"', async () => {
      await writeFile(join(testDir, 'package.json'), JSON.stringify({ type: 'commonjs' }), 'utf-8');

      const sdkFile = await createSdkInitFile(`
const { NodeSDK } = require('@opentelemetry/sdk-node');

const sdk = new NodeSDK({
  instrumentations: [],
});

sdk.start();
`);

      const libraries: LibraryRequirement[] = [
        makeLibrary('@opentelemetry/instrumentation-pg', 'PgInstrumentation'),
      ];

      const result = await updateSdkInitFile(sdkFile, libraries, testDir);

      expect(result.updated).toBe(true);

      const content = await readFile(sdkFile, 'utf-8');
      expect(content).toContain("require('@opentelemetry/instrumentation-pg')");
      expect(content).not.toContain("import { PgInstrumentation }");
    });

    it('falls back to file content heuristic when package.json is missing', async () => {
      // No package.json in testDir — should fall back to file content detection
      const sdkFile = await createSdkInitFile(`
import { NodeSDK } from '@opentelemetry/sdk-node';

const sdk = new NodeSDK({
  instrumentations: [],
});

sdk.start();
`);

      const libraries: LibraryRequirement[] = [
        makeLibrary('@opentelemetry/instrumentation-pg', 'PgInstrumentation'),
      ];

      // Pass a dir with no package.json
      const result = await updateSdkInitFile(sdkFile, libraries, testDir);

      expect(result.updated).toBe(true);

      const content = await readFile(sdkFile, 'utf-8');
      // Should detect ESM from file content and use ESM imports
      expect(content).toContain("import { PgInstrumentation } from '@opentelemetry/instrumentation-pg'");
    });

    it('generates ESM fallback when package.json has "type": "module"', async () => {
      await writeFile(join(testDir, 'package.json'), JSON.stringify({ type: 'module' }), 'utf-8');

      // File with no NodeSDK pattern and no ESM markers
      const sdkFile = await createSdkInitFile(`
// Custom setup
startTelemetry();
`);

      const libraries: LibraryRequirement[] = [
        makeLibrary('@opentelemetry/instrumentation-http', 'HttpInstrumentation'),
      ];

      const result = await updateSdkInitFile(sdkFile, libraries, testDir);

      expect(result.fallbackWritten).toBe(true);
      const fallbackContent = await readFile(result.fallbackPath!, 'utf-8');
      expect(fallbackContent).toContain("import { HttpInstrumentation }");
      expect(fallbackContent).toContain('export');
      expect(fallbackContent).not.toContain('require(');
    });
  });

  describe('edge cases', () => {
    it('returns no-op when libraries array is empty', async () => {
      const sdkFile = await createSdkInitFile(`
import { NodeSDK } from '@opentelemetry/sdk-node';

const sdk = new NodeSDK({
  instrumentations: [],
});

sdk.start();
`);

      const result = await updateSdkInitFile(sdkFile, []);

      expect(result.updated).toBe(false);
      expect(result.fallbackWritten).toBe(false);
    });

    it('returns no-op when all libraries already present', async () => {
      const sdkFile = await createSdkInitFile(`
import { NodeSDK } from '@opentelemetry/sdk-node';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';

const sdk = new NodeSDK({
  instrumentations: [
    new HttpInstrumentation(),
  ],
});

sdk.start();
`);

      const libraries: LibraryRequirement[] = [
        makeLibrary('@opentelemetry/instrumentation-http', 'HttpInstrumentation'),
      ];

      const result = await updateSdkInitFile(sdkFile, libraries);

      expect(result.updated).toBe(false);
      expect(result.fallbackWritten).toBe(false);
    });

    it('adds to instrumentations array even when import already exists', async () => {
      // Library is imported but not in the instrumentations array — should add to array
      // without duplicating the import
      const sdkFile = await createSdkInitFile(`
import { NodeSDK } from '@opentelemetry/sdk-node';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';

const sdk = new NodeSDK({
  instrumentations: [],
});

sdk.start();
`);

      const libraries: LibraryRequirement[] = [
        makeLibrary('@opentelemetry/instrumentation-http', 'HttpInstrumentation'),
      ];

      const result = await updateSdkInitFile(sdkFile, libraries);

      expect(result.updated).toBe(true);
      const content = await readFile(sdkFile, 'utf-8');
      // Should be added to the array
      expect(content).toContain('new HttpInstrumentation()');
      // Import should not be duplicated
      const importMatches = content.match(/import \{ HttpInstrumentation \}/g);
      expect(importMatches).toHaveLength(1);
    });

    it('deduplicates libraries by package name', async () => {
      const sdkFile = await createSdkInitFile(`
import { NodeSDK } from '@opentelemetry/sdk-node';

const sdk = new NodeSDK({
  instrumentations: [],
});

sdk.start();
`);

      const libraries: LibraryRequirement[] = [
        makeLibrary('@opentelemetry/instrumentation-pg', 'PgInstrumentation'),
        makeLibrary('@opentelemetry/instrumentation-pg', 'PgInstrumentation'),
      ];

      const result = await updateSdkInitFile(sdkFile, libraries);

      expect(result.updated).toBe(true);
      const content = await readFile(sdkFile, 'utf-8');
      const matches = content.match(/new PgInstrumentation\(\)/g);
      expect(matches).toHaveLength(1);
    });
  });
});

// ABOUTME: Real-world fixture tests for the TypeScript validator using actual taze source code.
// ABOUTME: Catches eval-discovered patterns (extensionless imports, Bundler resolution, OTel Prettier brace style).

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm, mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readFileSync } from 'node:fs';
import { checkSyntax } from '../../../src/languages/typescript/validation.ts';
import { checkNonInstrumentationDiff } from '../../../src/languages/javascript/rules/nds003.ts';

const FIXTURES_DIR = join(import.meta.dirname, '../../fixtures/real-world/taze');

// ---------------------------------------------------------------------------
// NDS-001: checkSyntax smoke test against real taze source
// ---------------------------------------------------------------------------

describe('checkSyntax — real-world taze fixture', () => {
  let tempDir: string;

  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  it('passes without NDS-001 false positives on taze check.ts with Bundler tsconfig', async () => {
    // The taze project uses moduleResolution: Bundler and extensionless relative
    // imports (e.g. `from '../types'`). This test verifies that checkSyntax reads
    // the taze tsconfig and does not report false type errors on real taze source code.
    tempDir = await mkdtemp(join(tmpdir(), 'spiny-orb-taze-'));

    // Mirror the fixture structure so tsconfig can be found by findTsconfig
    const srcDir = join(tempDir, 'src', 'api');
    const typesDir = join(tempDir, 'src');
    const ioDir = join(tempDir, 'src', 'io');
    const utilsDir = join(tempDir, 'src', 'utils');
    await mkdir(srcDir, { recursive: true });
    await mkdir(ioDir, { recursive: true });
    await mkdir(utilsDir, { recursive: true });

    // Write tsconfig at the project root
    const tazeConfig = readFileSync(join(FIXTURES_DIR, 'tsconfig.json'), 'utf-8');
    await writeFile(join(tempDir, 'tsconfig.json'), tazeConfig);

    // Write stub modules so TypeScript module resolution does not fail on missing
    // third-party imports. The real taze types are not available — we provide
    // stubs that satisfy the type references used in check.ts.
    await writeFile(join(typesDir, 'types.ts'), [
      'export interface CheckOptions { force?: boolean; concurrency?: number; write?: boolean; }',
      'export type DependencyFilter = (dep: RawDep) => boolean;',
      'export type DependencyResolvedCallback = (pkgName: string, name: string, progress: number, total: number) => void;',
      'export interface PackageMeta { name: string; private?: boolean; resolved: Array<{ update?: boolean }>; }',
      'export interface RawDep { name: string; }',
    ].join('\n'));

    await writeFile(join(ioDir, 'packages.ts'), [
      "import type { PackageMeta, CheckOptions } from '../types';",
      'export async function loadPackages(_opts: CheckOptions): Promise<PackageMeta[]> { return []; }',
      'export async function writePackage(_pkg: PackageMeta, _opts: CheckOptions): Promise<void> {}',
    ].join('\n'));

    await writeFile(join(ioDir, 'resolves.ts'), [
      "import type { PackageMeta, CheckOptions, DependencyResolvedCallback } from '../types';",
      'export async function loadCache(): Promise<void> {}',
      'export async function dumpCache(): Promise<void> {}',
      'export async function resolvePackage(_pkg: PackageMeta, _opts: CheckOptions, _filter: unknown, _cb?: DependencyResolvedCallback): Promise<void> {}',
    ].join('\n'));

    await writeFile(join(utilsDir, 'context.ts'), [
      "import type { } from '../types';",
      'export const queueContext = { run: async (_queue: unknown, fn: () => unknown) => fn() };',
    ].join('\n'));

    // Write a stub for @henrygd/queue (third-party import in check.ts)
    const queuePkgDir = join(tempDir, 'node_modules', '@henrygd', 'queue');
    await mkdir(queuePkgDir, { recursive: true });
    await writeFile(join(queuePkgDir, 'index.d.ts'), [
      'export interface Queue { }',
      'export declare function newQueue(concurrency: number): Queue;',
    ].join('\n'));
    await writeFile(join(queuePkgDir, 'package.json'), JSON.stringify({
      name: '@henrygd/queue', version: '0.0.0', main: 'index.js', types: 'index.d.ts',
    }));

    // Write the real taze check.ts file from the fixture
    const checkTs = readFileSync(join(FIXTURES_DIR, 'check.ts'), 'utf-8');
    const checkTsPath = join(srcDir, 'check.ts');
    await writeFile(checkTsPath, checkTs);

    const result = checkSyntax(checkTsPath);

    expect(
      result.passed,
      `NDS-001 false positive on real taze code: ${result.message}`,
    ).toBe(true);
    expect(result.ruleId).toBe('NDS-001');
  });
});

// ---------------------------------------------------------------------------
// NDS-003: real instrumented taze output passes non-destructiveness check
// ---------------------------------------------------------------------------

describe('checkNonInstrumentationDiff (NDS-003) — real-world taze fixture', () => {
  it('passes NDS-003 when instrumented taze check.ts matches Prettier brace style', () => {
    // This test verifies that the NDS-003 instrumentation-pattern filter handles
    // Prettier brace style: `} catch (e) {` on the same line as `}`.
    // Eval run-6 found that the agent produces this style on taze files.
    // The original taze check.ts has no OTel instrumentation; the instrumented
    // version adds spans using Prettier-standard brace placement.
    const original = readFileSync(join(FIXTURES_DIR, 'check.ts'), 'utf-8');

    // Build a representative instrumented version of the first exported function
    // (CheckPackages) as it would look after agent instrumentation.
    // This mirrors what the taze eval run-6 agent actually produced:
    // - OTel import added at top
    // - tracer constant after imports
    // - startActiveSpan wrapping the exported async functions
    // - Prettier-standard catch placement: `} catch (e) {` (same line as `}`)
    // The ABOUTME header from the fixture is preserved in both original and instrumented
    // so NDS-003's forward check does not flag it as missing.
    const instrumented = [
      '// ABOUTME: Static snapshot of taze src/api/check.ts for real-world validator testing.',
      '// ABOUTME: Tests that checkSyntax and NDS-003 handle real Bundler-resolution TypeScript without false positives.',
      "import type { CheckOptions, DependencyFilter, DependencyResolvedCallback, PackageMeta, RawDep } from '../types'",
      "import { trace, SpanStatusCode } from '@opentelemetry/api'",
      "import { newQueue } from '@henrygd/queue'",
      "import { loadPackages, writePackage } from '../io/packages'",
      "import { dumpCache, loadCache, resolvePackage } from '../io/resolves'",
      "import { queueContext } from '../utils/context'",
      '',
      'export interface CheckEventCallbacks {',
      '  afterPackagesLoaded?: (pkgs: PackageMeta[]) => void',
      '  beforePackageStart?: (pkg: PackageMeta) => void',
      '  afterPackageEnd?: (pkg: PackageMeta) => void',
      '  beforePackageWrite?: (pkg: PackageMeta) => boolean | Promise<boolean>',
      '  afterPackagesEnd?: (pkgs: PackageMeta[]) => void',
      '  afterPackageWrite?: (pkg: PackageMeta) => void',
      '  onDependencyResolved?: DependencyResolvedCallback',
      '}',
      '',
      "const tracer = trace.getTracer('taze')",
      '',
      'export async function CheckPackages(options: CheckOptions, callbacks: CheckEventCallbacks = {}) {',
      '  return tracer.startActiveSpan(\'CheckPackages\', async (span) => {',
      '    try {',
      '      if (!options.force)',
      '        await loadCache()',
      '',
      '      // packages loading',
      '      const packages = await loadPackages(options)',
      '      callbacks.afterPackagesLoaded?.(packages)',
      '',
      '      const privatePackageNames = packages',
      '        .filter(i => i.private)',
      '        .map(i => i.name)',
      '        .filter(i => i)',
      '',
      '      // to filter out private dependency in monorepo',
      '      const filter = (dep: RawDep) => !privatePackageNames.includes(dep.name)',
      '',
      '      let resolvedCount = 0',
      '      const onDependencyResolved: DependencyResolvedCallback = (pkgName, name, progress, total) => {',
      '        resolvedCount++',
      '        callbacks.onDependencyResolved?.(pkgName, name, resolvedCount, total)',
      '      }',
      '',
      '      const queue = newQueue(options.concurrency || 10)',
      '',
      '      await queueContext.run(queue, () => {',
      '        // run all CheckSingleProject in parallel',
      '        // the actual resolveDependencies within CheckSingleProject -> resolvePackage -> resolveDependencies is',
      '        // actually limited by the queueContext/queue, so it won\'t overwhelm the npm meta server.',
      '        return Promise.all(packages.map(async (pkg) => {',
      '          callbacks.beforePackageStart?.(pkg)',
      '          await CheckSingleProject(pkg, options, filter, { ...callbacks, onDependencyResolved })',
      '          callbacks.afterPackageEnd?.(pkg)',
      '        }))',
      '      })',
      '',
      '      callbacks.afterPackagesEnd?.(packages)',
      '',
      '      await dumpCache()',
      '',
      "      span.setAttribute('packages.count', packages.length)",
      '',
      '      return {',
      '        packages,',
      '      }',
      '    } catch (e: unknown) {',
      '      if (e instanceof Error) {',
      '        span.recordException(e)',
      '      }',
      '      span.setStatus({ code: SpanStatusCode.ERROR })',
      '      throw e',
      '    } finally {',
      '      span.end()',
      '    }',
      '  })',
      '}',
      '',
      'async function CheckSingleProject(pkg: PackageMeta, options: CheckOptions, filter: DependencyFilter = () => true, callbacks: CheckEventCallbacks = {}) {',
      '  await resolvePackage(pkg, options, filter, callbacks.onDependencyResolved)',
      '',
      '  const { resolved } = pkg',
      '  const changes = resolved.filter(i => i.update)',
      '',
      '  if (options.write && changes.length) {',
      '    const shouldWrite = await Promise.resolve(callbacks.beforePackageWrite?.(pkg))',
      '',
      '    if (shouldWrite !== false) {',
      '      await writePackage(pkg, options)',
      '      callbacks.afterPackageWrite?.(pkg)',
      '    }',
      '  }',
      '  return pkg',
      '}',
    ].join('\n');

    const results = checkNonInstrumentationDiff(original, instrumented, '/tmp/taze-check.ts');

    const failures = results.filter(r => !r.passed);
    expect(
      failures,
      `NDS-003 false positives on real taze instrumented code:\n${failures.map(f => f.message).join('\n')}`,
    ).toHaveLength(0);
  });
});

// ABOUTME: Unit tests for resolveCanonicalTracerName.
// ABOUTME: Covers config override, registry-derived name with normalization, and no-underscore passthrough.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveCanonicalTracerName } from '../../src/coordinator/tracer-name.ts';
import type { AgentConfig } from '../../src/config/schema.ts';

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    schemaPath: './telemetry/registry',
    sdkInitFile: './src/telemetry/setup.js',
    agentModel: 'claude-sonnet-4-6',
    agentEffort: 'medium',
    testCommand: 'npm test',
    targetType: 'long-lived',
    language: 'javascript',
    dependencyStrategy: 'dependencies',
    maxFilesPerRun: 50,
    maxFixAttempts: 2,
    maxTokensPerFile: 100000,
    largeFileThresholdLines: 500,
    schemaCheckpointInterval: 5,
    attributesPerFileThreshold: 30,
    spansPerFileThreshold: 20,
    weaverMinVersion: '0.21.2',
    reviewSensitivity: 'moderate',
    dryRun: false,
    confirmEstimate: true,
    exclude: [],
    ...overrides,
  };
}

async function makeRegistryDir(manifestName: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tracer-name-test-'));
  await writeFile(
    join(dir, 'registry_manifest.yaml'),
    `name: ${manifestName}\ndescription: Test registry\n`,
  );
  return dir;
}

describe('resolveCanonicalTracerName', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs) {
      await rm(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  it('returns config tracerName exactly when set', async () => {
    const dir = await makeRegistryDir('commit_story');
    tempDirs.push(dir);
    const config = makeConfig({ tracerName: 'my-custom-tracer' });
    const result = await resolveCanonicalTracerName(config, dir);
    expect(result).toBe('my-custom-tracer');
  });

  it('returns config tracerName with underscores as-is (no normalization of config value)', async () => {
    const dir = await makeRegistryDir('commit_story');
    tempDirs.push(dir);
    const config = makeConfig({ tracerName: 'my_custom_tracer' });
    const result = await resolveCanonicalTracerName(config, dir);
    expect(result).toBe('my_custom_tracer');
  });

  it('normalizes registry name underscores to hyphens when tracerName not set', async () => {
    const dir = await makeRegistryDir('commit_story');
    tempDirs.push(dir);
    const config = makeConfig();
    const result = await resolveCanonicalTracerName(config, dir);
    expect(result).toBe('commit-story');
  });

  it('normalizes multiple underscores in registry name', async () => {
    const dir = await makeRegistryDir('my_app');
    tempDirs.push(dir);
    const config = makeConfig();
    const result = await resolveCanonicalTracerName(config, dir);
    expect(result).toBe('my-app');
  });

  it('returns registry name unchanged when it has no underscores', async () => {
    const dir = await makeRegistryDir('myservice');
    tempDirs.push(dir);
    const config = makeConfig();
    const result = await resolveCanonicalTracerName(config, dir);
    expect(result).toBe('myservice');
  });
});

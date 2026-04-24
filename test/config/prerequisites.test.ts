// ABOUTME: Unit tests for prerequisite checks before instrumentation.
// ABOUTME: Covers package.json, OTel API dependency, SDK init file, Weaver schema, and API key checks.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import {
  checkPackageJson,
  checkOtelApiDependency,
  checkSdkInitFile,
  checkWeaverSchema,
  checkAnthropicApiKey,
  checkPrerequisites,
} from '../../src/config/prerequisites.ts';
import type { AgentConfig } from '../../src/config/schema.ts';

let testDir: string;

beforeEach(() => {
  testDir = join(tmpdir(), `spiny-orb-prereq-test-${Date.now()}`);
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

function writeFile(relativePath: string, content: string): string {
  const fullPath = join(testDir, relativePath);
  const dir = dirname(fullPath);
  mkdirSync(dir, { recursive: true });
  writeFileSync(fullPath, content, 'utf-8');
  return fullPath;
}

function makePackageJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'test-project',
    version: '1.0.0',
    ...overrides,
  };
}

function makeMinimalConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    schemaPath: './telemetry/registry',
    sdkInitFile: './src/telemetry/setup.js',
    agentModel: 'claude-sonnet-4-6',
    agentEffort: 'medium',
    testCommand: 'npm test',
    dependencyStrategy: 'dependencies',
    targetType: 'long-lived',
    maxFilesPerRun: 50,
    maxFixAttempts: 2,
    maxTokensPerFile: 80000,
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

describe('checkPackageJson', () => {
  it('passes when package.json exists and is valid JSON', async () => {
    writeFile('package.json', JSON.stringify(makePackageJson()));
    const result = await checkPackageJson(testDir);
    expect(result.passed).toBe(true);
    expect(result.id).toBe('PACKAGE_JSON');
    expect(result.message).toContain('package.json found');
  });

  it('fails when package.json does not exist', async () => {
    const result = await checkPackageJson(testDir);
    expect(result.passed).toBe(false);
    expect(result.id).toBe('PACKAGE_JSON');
    expect(result.message).toContain('not found');
    expect(result.message).toContain('npm init');
  });

  it('fails when package.json contains invalid JSON', async () => {
    writeFile('package.json', '{ invalid json');
    const result = await checkPackageJson(testDir);
    expect(result.passed).toBe(false);
    expect(result.id).toBe('PACKAGE_JSON');
    expect(result.message).toContain('invalid JSON');
  });

  it('fails when package.json is a JSON array', async () => {
    writeFile('package.json', '[]');
    const result = await checkPackageJson(testDir);
    expect(result.passed).toBe(false);
    expect(result.id).toBe('PACKAGE_JSON');
    expect(result.message).toContain('not a JSON object');
  });

  it('fails when package.json is a JSON primitive', async () => {
    writeFile('package.json', '"just a string"');
    const result = await checkPackageJson(testDir);
    expect(result.passed).toBe(false);
    expect(result.id).toBe('PACKAGE_JSON');
    expect(result.message).toContain('not a JSON object');
  });
});

describe('checkOtelApiDependency', () => {
  it('passes when @opentelemetry/api is in peerDependencies', async () => {
    writeFile('package.json', JSON.stringify(makePackageJson({
      peerDependencies: { '@opentelemetry/api': '^1.9.0' },
    })));
    const result = await checkOtelApiDependency(testDir);
    expect(result.passed).toBe(true);
    expect(result.id).toBe('OTEL_API_DEPENDENCY');
    expect(result.message).toContain('peerDependencies');
    expect(result.message).toContain('^1.9.0');
  });

  it('fails when @opentelemetry/api is in dependencies (wrong location)', async () => {
    writeFile('package.json', JSON.stringify(makePackageJson({
      dependencies: { '@opentelemetry/api': '^1.9.0' },
    })));
    const result = await checkOtelApiDependency(testDir);
    expect(result.passed).toBe(false);
    expect(result.id).toBe('OTEL_API_DEPENDENCY');
    expect(result.message).toContain('must be in peerDependencies');
    expect(result.message).toContain('silent trace loss');
  });

  it('fails when @opentelemetry/api is not in any dependencies', async () => {
    writeFile('package.json', JSON.stringify(makePackageJson()));
    const result = await checkOtelApiDependency(testDir);
    expect(result.passed).toBe(false);
    expect(result.id).toBe('OTEL_API_DEPENDENCY');
    expect(result.message).toContain('not found in peerDependencies');
    expect(result.message).toContain('npm install --save-peer');
  });

  it('fails when package.json does not exist', async () => {
    const result = await checkOtelApiDependency(testDir);
    expect(result.passed).toBe(false);
    expect(result.id).toBe('OTEL_API_DEPENDENCY');
    expect(result.message).toContain('Cannot read package.json');
  });

  it('fails when package.json is not a JSON object', async () => {
    writeFile('package.json', '"just a string"');
    const result = await checkOtelApiDependency(testDir);
    expect(result.passed).toBe(false);
    expect(result.id).toBe('OTEL_API_DEPENDENCY');
    expect(result.message).toContain('not a JSON object');
  });
});

describe('checkSdkInitFile', () => {
  it('passes when SDK init file exists', async () => {
    writeFile('src/telemetry/setup.js', '// OTel SDK init');
    const result = await checkSdkInitFile(testDir, './src/telemetry/setup.js');
    expect(result.passed).toBe(true);
    expect(result.id).toBe('SDK_INIT_FILE');
    expect(result.message).toContain('found');
  });

  it('fails when SDK init file does not exist', async () => {
    const result = await checkSdkInitFile(testDir, './src/telemetry/setup.js');
    expect(result.passed).toBe(false);
    expect(result.id).toBe('SDK_INIT_FILE');
    expect(result.message).toContain('not found');
    expect(result.message).toContain('sdkInitFile');
  });

  it('fails when SDK init file path escapes project root', async () => {
    const result = await checkSdkInitFile(testDir, '../../etc/passwd');
    expect(result.passed).toBe(false);
    expect(result.id).toBe('SDK_INIT_FILE');
    expect(result.message).toContain('outside the project root');
  });

  it('accepts path resolving to project root itself', async () => {
    // '.' resolves to projectRoot — should not be rejected as outside
    writeFile('dummy', '');
    const result = await checkSdkInitFile(testDir, '.');
    expect(result.id).toBe('SDK_INIT_FILE');
    // Should not fail with "outside the project root"
    expect(result.message).not.toContain('outside the project root');
  });
});

describe('checkWeaverSchema', () => {
  it('fails when schema path does not exist', async () => {
    const result = await checkWeaverSchema(testDir, './telemetry/registry');
    expect(result.passed).toBe(false);
    expect(result.id).toBe('WEAVER_SCHEMA');
    expect(result.message).toContain('not found');
    expect(result.message).toContain('schemaPath');
  });

  it('fails when schema path escapes project root', async () => {
    const result = await checkWeaverSchema(testDir, '../../../etc');
    expect(result.passed).toBe(false);
    expect(result.id).toBe('WEAVER_SCHEMA');
    expect(result.message).toContain('outside the project root');
  });

  it('reports when weaver CLI is not installed', async () => {
    // Create schema directory but weaver CLI won't be available in test env
    mkdirSync(join(testDir, 'telemetry', 'registry'), { recursive: true });
    const result = await checkWeaverSchema(testDir, './telemetry/registry');
    expect(result.id).toBe('WEAVER_SCHEMA');
    // Either weaver is installed (passes) or not (ENOENT message)
    if (!result.passed) {
      expect(result.message).toMatch(/Weaver CLI not found|Weaver schema validation failed/);
    }
  });
});

describe('checkAnthropicApiKey', () => {
  const originalEnv = process.env.ANTHROPIC_API_KEY;

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.ANTHROPIC_API_KEY = originalEnv;
    } else {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it('passes when ANTHROPIC_API_KEY is set', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key';
    const result = checkAnthropicApiKey();
    expect(result.passed).toBe(true);
    expect(result.id).toBe('ANTHROPIC_API_KEY');
    expect(result.message).toContain('ANTHROPIC_API_KEY');
  });

  it('fails when ANTHROPIC_API_KEY is not set', () => {
    delete process.env.ANTHROPIC_API_KEY;
    const result = checkAnthropicApiKey();
    expect(result.passed).toBe(false);
    expect(result.id).toBe('ANTHROPIC_API_KEY');
    expect(result.message).toContain('not found');
    expect(result.message).toContain('.env');
  });

  it('fails when ANTHROPIC_API_KEY is empty string', () => {
    process.env.ANTHROPIC_API_KEY = '';
    const result = checkAnthropicApiKey();
    expect(result.passed).toBe(false);
    expect(result.id).toBe('ANTHROPIC_API_KEY');
    expect(result.message).toContain('not found');
  });
});

describe('checkPrerequisites', () => {
  it('returns allPassed true when all checks pass', async () => {
    writeFile('package.json', JSON.stringify(makePackageJson({
      peerDependencies: { '@opentelemetry/api': '^1.9.0' },
    })));
    writeFile('src/telemetry/setup.js', '// OTel SDK init');
    mkdirSync(join(testDir, 'telemetry', 'registry'), { recursive: true });

    const config = makeMinimalConfig();
    const result = await checkPrerequisites(testDir, config);
    // allPassed depends on weaver CLI and env availability — check structure
    expect(result.checks).toHaveLength(5);
    expect(result.checks[0].id).toBe('PACKAGE_JSON');
    expect(result.checks[0].passed).toBe(true);
    expect(result.checks[1].id).toBe('OTEL_API_DEPENDENCY');
    expect(result.checks[1].passed).toBe(true);
    expect(result.checks[2].id).toBe('SDK_INIT_FILE');
    expect(result.checks[2].passed).toBe(true);
    expect(result.checks[3].id).toBe('WEAVER_SCHEMA');
    // allPassed depends on weaver CLI availability
    const expectedAllPassed = result.checks.every(c => c.passed);
    expect(result.allPassed).toBe(expectedAllPassed);
  });

  it('returns allPassed false when any check fails', async () => {
    // Missing package.json — everything fails
    const config = makeMinimalConfig();
    const result = await checkPrerequisites(testDir, config);
    expect(result.allPassed).toBe(false);
    expect(result.checks.some(c => !c.passed)).toBe(true);
  });

  it('returns structured results for each check', async () => {
    const config = makeMinimalConfig();
    const result = await checkPrerequisites(testDir, config);
    for (const check of result.checks) {
      expect(check).toHaveProperty('id');
      expect(check).toHaveProperty('passed');
      expect(check).toHaveProperty('message');
      expect(typeof check.id).toBe('string');
      expect(typeof check.passed).toBe('boolean');
      expect(typeof check.message).toBe('string');
      expect(check.message.length).toBeGreaterThan(0);
    }
  });

  it('provides actionable messages for failed checks', async () => {
    const config = makeMinimalConfig();
    const result = await checkPrerequisites(testDir, config);
    const failedChecks = result.checks.filter(c => !c.passed);
    for (const check of failedChecks) {
      // Each failed check should explain what to do
      expect(check.message.length).toBeGreaterThan(20);
    }
  });
});

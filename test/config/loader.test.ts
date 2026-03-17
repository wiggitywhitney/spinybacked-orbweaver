// ABOUTME: Unit tests for config loading from YAML and typo detection.
// ABOUTME: Covers YAML parsing, file-not-found errors, validation errors, and typo suggestions.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig, validateConfig } from '../../src/config/loader.ts';

let testDir: string;

beforeEach(() => {
  testDir = join(tmpdir(), `spiny-orb-test-${Date.now()}`);
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

function writeYaml(filename: string, content: string): string {
  const filePath = join(testDir, filename);
  writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

describe('loadConfig', () => {
  it('loads and parses a valid minimal spiny-orb.yaml', async () => {
    const configPath = writeYaml('spiny-orb.yaml', `
schemaPath: ./telemetry/registry
sdkInitFile: ./src/telemetry/setup.js
`);
    const result = await loadConfig(configPath);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.config.schemaPath).toBe('./telemetry/registry');
      expect(result.config.sdkInitFile).toBe('./src/telemetry/setup.js');
      expect(result.config.agentModel).toBe('claude-sonnet-4-6');
    }
  });

  it('loads a full config with all fields', async () => {
    const configPath = writeYaml('spiny-orb.yaml', `
schemaPath: ./telemetry/registry
sdkInitFile: ./src/telemetry/setup.js
agentModel: claude-sonnet-4-6
agentEffort: high
autoApproveLibraries: false
testCommand: "vitest run"
dependencyStrategy: peerDependencies
maxFilesPerRun: 100
maxFixAttempts: 3
maxTokensPerFile: 120000
largeFileThresholdLines: 1000
schemaCheckpointInterval: 10
weaverMinVersion: "0.22.0"
reviewSensitivity: strict
dryRun: true
confirmEstimate: false
exclude:
  - "**/*.test.js"
  - "dist/**"
`);
    const result = await loadConfig(configPath);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.config.agentEffort).toBe('high');
      expect(result.config.autoApproveLibraries).toBe(false);
      expect(result.config.testCommand).toBe('vitest run');
      expect(result.config.dependencyStrategy).toBe('peerDependencies');
      expect(result.config.maxFilesPerRun).toBe(100);
      expect(result.config.dryRun).toBe(true);
      expect(result.config.exclude).toEqual(['**/*.test.js', 'dist/**']);
    }
  });

  it('returns structured error when file does not exist', async () => {
    const result = await loadConfig(join(testDir, 'nonexistent.yaml'));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('FILE_NOT_FOUND');
      expect(result.error.message).toContain('nonexistent.yaml');
    }
  });

  it('returns structured error for invalid YAML syntax', async () => {
    const configPath = writeYaml('spiny-orb.yaml', `
schemaPath: ./telemetry/registry
sdkInitFile: [invalid yaml
`);
    const result = await loadConfig(configPath);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('YAML_PARSE_ERROR');
    }
  });

  it('returns structured error for non-object YAML', async () => {
    const configPath = writeYaml('spiny-orb.yaml', `just a string`);
    const result = await loadConfig(configPath);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('INVALID_CONFIG');
    }
  });
});

describe('validateConfig', () => {
  it('returns validated config for valid input', () => {
    const result = validateConfig({
      schemaPath: './telemetry/registry',
      sdkInitFile: './src/telemetry/setup.js',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.config.schemaPath).toBe('./telemetry/registry');
    }
  });

  it('returns validation errors for missing required fields', () => {
    const result = validateConfig({});
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('VALIDATION_ERROR');
      expect(result.error.message).toContain('schemaPath');
    }
  });

  it('returns validation errors for invalid types', () => {
    const result = validateConfig({
      schemaPath: 42,
      sdkInitFile: './src/telemetry/setup.js',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('VALIDATION_ERROR');
    }
  });
});

describe('typo detection', () => {
  it('suggests closest field name for a typo', () => {
    const result = validateConfig({
      schemaPath: './telemetry/registry',
      sdkInitFile: './src/telemetry/setup.js',
      maxSpanPerFile: 10,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('UNKNOWN_FIELDS');
      expect(result.error.message).toContain('maxSpanPerFile');
      // Levenshtein: maxSpanPerFile → maxTimePerFile (distance 3) is now closest
      expect(result.error.message).toContain('maxTimePerFile');
    }
  });

  it('suggests correct field for multiple typos', () => {
    const result = validateConfig({
      schemaPath: './telemetry/registry',
      sdkInitFile: './src/telemetry/setup.js',
      maxSpanPerFile: 10,
      dryrun: false,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('UNKNOWN_FIELDS');
      expect(result.error.message).toContain('maxSpanPerFile');
      expect(result.error.message).toContain('dryrun');
      expect(result.error.message).toContain('dryRun');
    }
  });

  it('reports unknown fields without suggestion when no close match', () => {
    const result = validateConfig({
      schemaPath: './telemetry/registry',
      sdkInitFile: './src/telemetry/setup.js',
      completelyBogusField: 'wat',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('UNKNOWN_FIELDS');
      expect(result.error.message).toContain('completelyBogusField');
    }
  });
});

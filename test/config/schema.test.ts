// ABOUTME: Unit tests for AgentConfig Zod schema validation.
// ABOUTME: Covers valid configs, defaults, invalid fields, enum validation, and type errors.

import { describe, it, expect } from 'vitest';
import { AgentConfigSchema } from '../../src/config/schema.ts';

// Helper: minimal valid config (only required fields)
function makeMinimalConfig() {
  return {
    schemaPath: './telemetry/registry',
    sdkInitFile: './src/telemetry/setup.js',
  };
}

// Helper: full valid config (all fields explicit)
function makeFullConfig() {
  return {
    schemaPath: './telemetry/registry',
    sdkInitFile: './src/telemetry/setup.js',
    agentModel: 'claude-sonnet-4-6',
    agentEffort: 'medium',
    autoApproveLibraries: true,
    testCommand: 'npm test',
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
    exclude: ['**/*.test.js', '**/*.spec.js', 'src/generated/**'],
  };
}

describe('AgentConfigSchema', () => {
  describe('valid configs', () => {
    it('parses a minimal config with only required fields', () => {
      const result = AgentConfigSchema.safeParse(makeMinimalConfig());
      expect(result.success).toBe(true);
    });

    it('parses a full config with all fields explicit', () => {
      const result = AgentConfigSchema.safeParse(makeFullConfig());
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual(makeFullConfig());
      }
    });
  });

  describe('defaults', () => {
    it('applies all defaults when only required fields provided', () => {
      const result = AgentConfigSchema.safeParse(makeMinimalConfig());
      expect(result.success).toBe(true);
      if (!result.success) return;

      const config = result.data;
      expect(config.agentModel).toBe('claude-sonnet-4-6');
      expect(config.agentEffort).toBe('medium');
      expect(config.autoApproveLibraries).toBe(true);
      expect(config.testCommand).toBe('npm test');
      expect(config.dependencyStrategy).toBe('dependencies');
      expect(config.maxFilesPerRun).toBe(50);
      expect(config.maxFixAttempts).toBe(2);
      expect(config.maxTokensPerFile).toBe(100000);
      expect(config.largeFileThresholdLines).toBe(500);
      expect(config.schemaCheckpointInterval).toBe(5);
      expect(config.attributesPerFileThreshold).toBe(30);
      expect(config.spansPerFileThreshold).toBe(20);
      expect(config.weaverMinVersion).toBe('0.21.2');
      expect(config.reviewSensitivity).toBe('moderate');
      expect(config.dryRun).toBe(false);
      expect(config.confirmEstimate).toBe(true);
      expect(config.exclude).toEqual([]);
    });
  });

  describe('required fields', () => {
    it('rejects config missing schemaPath', () => {
      const { schemaPath, ...rest } = makeMinimalConfig();
      const result = AgentConfigSchema.safeParse(rest);
      expect(result.success).toBe(false);
    });

    it('rejects config missing sdkInitFile', () => {
      const { sdkInitFile, ...rest } = makeMinimalConfig();
      const result = AgentConfigSchema.safeParse(rest);
      expect(result.success).toBe(false);
    });

    it('rejects empty string schemaPath', () => {
      const result = AgentConfigSchema.safeParse({
        ...makeMinimalConfig(),
        schemaPath: '',
      });
      expect(result.success).toBe(false);
    });

    it('rejects empty string sdkInitFile', () => {
      const result = AgentConfigSchema.safeParse({
        ...makeMinimalConfig(),
        sdkInitFile: '',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('enum validation', () => {
    it('rejects invalid agentEffort value', () => {
      const result = AgentConfigSchema.safeParse({
        ...makeMinimalConfig(),
        agentEffort: 'extreme',
      });
      expect(result.success).toBe(false);
    });

    it('accepts all valid agentEffort values', () => {
      for (const effort of ['low', 'medium', 'high']) {
        const result = AgentConfigSchema.safeParse({
          ...makeMinimalConfig(),
          agentEffort: effort,
        });
        expect(result.success).toBe(true);
      }
    });

    it('rejects invalid dependencyStrategy value', () => {
      const result = AgentConfigSchema.safeParse({
        ...makeMinimalConfig(),
        dependencyStrategy: 'devDependencies',
      });
      expect(result.success).toBe(false);
    });

    it('accepts all valid dependencyStrategy values', () => {
      for (const strategy of ['dependencies', 'peerDependencies']) {
        const result = AgentConfigSchema.safeParse({
          ...makeMinimalConfig(),
          dependencyStrategy: strategy,
        });
        expect(result.success).toBe(true);
      }
    });

    it('rejects invalid reviewSensitivity value', () => {
      const result = AgentConfigSchema.safeParse({
        ...makeMinimalConfig(),
        reviewSensitivity: 'paranoid',
      });
      expect(result.success).toBe(false);
    });

    it('accepts all valid reviewSensitivity values', () => {
      for (const sensitivity of ['strict', 'moderate', 'off']) {
        const result = AgentConfigSchema.safeParse({
          ...makeMinimalConfig(),
          reviewSensitivity: sensitivity,
        });
        expect(result.success).toBe(true);
      }
    });
  });

  describe('type validation', () => {
    it('rejects non-string schemaPath', () => {
      const result = AgentConfigSchema.safeParse({
        ...makeMinimalConfig(),
        schemaPath: 42,
      });
      expect(result.success).toBe(false);
    });

    it('rejects non-boolean autoApproveLibraries', () => {
      const result = AgentConfigSchema.safeParse({
        ...makeMinimalConfig(),
        autoApproveLibraries: 'yes',
      });
      expect(result.success).toBe(false);
    });

    it('rejects non-number maxFilesPerRun', () => {
      const result = AgentConfigSchema.safeParse({
        ...makeMinimalConfig(),
        maxFilesPerRun: 'fifty',
      });
      expect(result.success).toBe(false);
    });

    it('rejects non-array exclude', () => {
      const result = AgentConfigSchema.safeParse({
        ...makeMinimalConfig(),
        exclude: '**/*.test.js',
      });
      expect(result.success).toBe(false);
    });

    it('rejects exclude with non-string elements', () => {
      const result = AgentConfigSchema.safeParse({
        ...makeMinimalConfig(),
        exclude: [123, true],
      });
      expect(result.success).toBe(false);
    });
  });

  describe('numeric constraints', () => {
    it('rejects negative maxFilesPerRun', () => {
      const result = AgentConfigSchema.safeParse({
        ...makeMinimalConfig(),
        maxFilesPerRun: -1,
      });
      expect(result.success).toBe(false);
    });

    it('rejects zero maxFilesPerRun', () => {
      const result = AgentConfigSchema.safeParse({
        ...makeMinimalConfig(),
        maxFilesPerRun: 0,
      });
      expect(result.success).toBe(false);
    });

    it('rejects negative maxFixAttempts', () => {
      const result = AgentConfigSchema.safeParse({
        ...makeMinimalConfig(),
        maxFixAttempts: -1,
      });
      expect(result.success).toBe(false);
    });

    it('accepts zero maxFixAttempts (no retries)', () => {
      const result = AgentConfigSchema.safeParse({
        ...makeMinimalConfig(),
        maxFixAttempts: 0,
      });
      expect(result.success).toBe(true);
    });

    it('rejects non-integer maxFilesPerRun', () => {
      const result = AgentConfigSchema.safeParse({
        ...makeMinimalConfig(),
        maxFilesPerRun: 10.5,
      });
      expect(result.success).toBe(false);
    });
  });

  describe('checkpointLocThreshold', () => {
    it('is undefined by default when omitted', () => {
      const result = AgentConfigSchema.safeParse(makeMinimalConfig());
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.checkpointLocThreshold).toBeUndefined();
      }
    });

    it('accepts a positive integer', () => {
      const result = AgentConfigSchema.safeParse({
        ...makeMinimalConfig(),
        checkpointLocThreshold: 200,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.checkpointLocThreshold).toBe(200);
      }
    });

    it('rejects zero', () => {
      const result = AgentConfigSchema.safeParse({
        ...makeMinimalConfig(),
        checkpointLocThreshold: 0,
      });
      expect(result.success).toBe(false);
    });

    it('rejects negative values', () => {
      const result = AgentConfigSchema.safeParse({
        ...makeMinimalConfig(),
        checkpointLocThreshold: -10,
      });
      expect(result.success).toBe(false);
    });

    it('rejects non-integer values', () => {
      const result = AgentConfigSchema.safeParse({
        ...makeMinimalConfig(),
        checkpointLocThreshold: 10.5,
      });
      expect(result.success).toBe(false);
    });
  });

  describe('reserved fields', () => {
    it('accepts instrumentationMode without error', () => {
      const result = AgentConfigSchema.safeParse({
        ...makeMinimalConfig(),
        instrumentationMode: 'balanced',
      });
      expect(result.success).toBe(true);
    });

    it('does not include instrumentationMode in parsed output when omitted', () => {
      const result = AgentConfigSchema.safeParse(makeMinimalConfig());
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).not.toHaveProperty('instrumentationMode');
      }
    });
  });

  describe('unknown fields', () => {
    it('rejects unknown fields', () => {
      const result = AgentConfigSchema.safeParse({
        ...makeMinimalConfig(),
        maxSpanPerFile: 10,
      });
      expect(result.success).toBe(false);
    });
  });
});

// ABOUTME: Tests for the GitHub Action action.yml.
// ABOUTME: Validates YAML structure, inputs, outputs, setup steps, and CLI invocation.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

describe('GitHub Action (action.yml)', () => {
  let action: Record<string, unknown>;

  beforeAll(() => {
    const content = readFileSync(
      resolve(import.meta.dirname, '../../action.yml'),
      'utf-8',
    );
    action = parse(content) as Record<string, unknown>;
  });

  it('has required top-level fields', () => {
    expect(action).toHaveProperty('name');
    expect(action).toHaveProperty('description');
    expect(action).toHaveProperty('inputs');
    expect(action).toHaveProperty('runs');
  });

  it('is a composite action', () => {
    const runs = action.runs as Record<string, unknown>;
    expect(runs.using).toBe('composite');
  });

  describe('inputs', () => {
    it('has a path input with default', () => {
      const inputs = action.inputs as Record<string, Record<string, unknown>>;
      expect(inputs.path).toBeDefined();
      expect(inputs.path.description).toBeDefined();
      expect(inputs.path.default).toBe('src');
    });

    it('has a node-version input defaulting to 24', () => {
      const inputs = action.inputs as Record<string, Record<string, unknown>>;
      expect(inputs['node-version']).toBeDefined();
      expect(inputs['node-version'].default).toBe('24');
    });

    it('has a weaver-version input', () => {
      const inputs = action.inputs as Record<string, Record<string, unknown>>;
      expect(inputs['weaver-version']).toBeDefined();
      expect(inputs['weaver-version'].default).toBeDefined();
    });
  });

  describe('outputs', () => {
    it('exposes a result output', () => {
      const outputs = action.outputs as Record<
        string,
        Record<string, unknown>
      >;
      expect(outputs.result).toBeDefined();
      expect(outputs.result.description).toBeDefined();
    });

    it('exposes a summary output', () => {
      const outputs = action.outputs as Record<
        string,
        Record<string, unknown>
      >;
      expect(outputs.summary).toBeDefined();
      expect(outputs.summary.description).toBeDefined();
    });
  });

  describe('steps', () => {
    let steps: Array<Record<string, unknown>>;

    beforeAll(() => {
      const runs = action.runs as Record<string, unknown>;
      steps = runs.steps as Array<Record<string, unknown>>;
    });

    it('has setup-node step using actions/setup-node@v4', () => {
      const setupNode = steps.find(
        (s) => typeof s.uses === 'string' && s.uses.includes('setup-node'),
      );
      expect(setupNode).toBeDefined();
      expect(setupNode!.uses).toBe('actions/setup-node@v4');
    });

    it('installs npm dependencies', () => {
      const npmInstall = steps.find(
        (s) => typeof s.run === 'string' && s.run.includes('npm install'),
      );
      expect(npmInstall).toBeDefined();
    });

    it('installs Weaver via binary download (not go install)', () => {
      const weaverStep = steps.find(
        (s) =>
          typeof s.name === 'string' &&
          s.name.toLowerCase().includes('weaver'),
      );
      expect(weaverStep).toBeDefined();
      const run = weaverStep!.run as string;
      // Uses binary download, not go install
      expect(run).not.toContain('go install');
      // Downloads from GitHub releases
      expect(run).toContain('github.com');
      expect(run).toContain('weaver');
    });

    it('runs orb instrument with --yes and --output json', () => {
      const instrumentStep = steps.find(
        (s) =>
          typeof s.run === 'string' && s.run.includes('orb instrument'),
      );
      expect(instrumentStep).toBeDefined();
      const run = instrumentStep!.run as string;
      expect(run).toContain('--yes');
      expect(run).toContain('--output json');
    });

    it('logs cost ceiling via echo/core.info pattern', () => {
      // The action should parse the JSON result and log cost info
      const resultStep = steps.find(
        (s) =>
          typeof s.run === 'string' &&
          (s.run.includes('::notice') || s.run.includes('cost')),
      );
      expect(resultStep).toBeDefined();
    });

    it('sets step outputs for result and summary', () => {
      const stepsText = steps
        .map((s) => (typeof s.run === 'string' ? s.run : ''))
        .join('\n');
      expect(stepsText).toContain('GITHUB_OUTPUT');
    });

    it('all shell steps use bash', () => {
      const shellSteps = steps.filter(
        (s) => typeof s.run === 'string',
      );
      for (const step of shellSteps) {
        expect(step.shell).toBe('bash');
      }
    });
  });
});

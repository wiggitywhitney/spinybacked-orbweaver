// ABOUTME: Acceptance gate end-to-end test for Phase 1 — calls real Anthropic API.
// ABOUTME: Verifies instrumentFile produces valid output meeting all rubric criteria.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { instrumentFile } from '../src/agent/instrument-file.ts';
import type { AgentConfig } from '../src/config/schema.ts';
import { JavaScriptProvider } from '../src/languages/javascript/index.ts';
import {
  checkSyntaxValid,
  checkNonInstrumentationLinesUnchanged,
  checkPublicApiPreserved,
  checkErrorHandlingPreserved,
  checkOtelImportsApiOnly,
  checkSpansClosed,
  checkTracerAcquired,
  checkErrorRecording,
  checkAsyncContext,
  checkAttributeSafety,
} from './helpers/rubric-checks.ts';

const FIXTURES_DIR = join(import.meta.dirname, 'fixtures', 'project');
const API_KEY_AVAILABLE = !!process.env.ANTHROPIC_API_KEY;

/** Load a fixture file. */
function loadFixture(relativePath: string): string {
  return readFileSync(join(FIXTURES_DIR, relativePath), 'utf-8');
}

/** Load the resolved schema. */
function loadResolvedSchema(): object {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, 'resolved-schema.json'), 'utf-8'));
}

/** Create a test config. Uses 16000 max tokens — sufficient for fixture files
 * and avoids Anthropic SDK streaming requirement for large token budgets. */
function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    schemaPath: './telemetry/registry',
    sdkInitFile: './src/telemetry.ts',
    agentModel: 'claude-sonnet-4-6',
    agentEffort: 'medium',
    testCommand: 'npm test',
    dependencyStrategy: 'dependencies',
    targetType: 'long-lived',
    language: 'javascript',
    maxFilesPerRun: 50,
    maxFixAttempts: 2,
    maxTokensPerFile: 16000,
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

/**
 * Run all rubric checks on instrumented code and return a summary.
 * Checks that make sense only when code was modified (not skipped).
 */
function runRubricChecks(
  original: string,
  instrumented: string,
  checks: {
    nds001?: boolean;
    nds003?: boolean;
    nds004?: boolean;
    nds005?: boolean;
    api001?: boolean;
    cdq001?: boolean;
    cdq002?: boolean;
    cdq003?: boolean;
    cdq005?: boolean;
    cdq007?: boolean;
  } = {},
) {
  const enabled = {
    nds001: true, nds003: true, nds004: true, nds005: true,
    api001: true, cdq001: true, cdq002: true, cdq003: true,
    cdq005: true, cdq007: true,
    ...checks,
  };

  const results: Record<string, { passed: boolean; details?: string }> = {};

  if (enabled.nds001) results['NDS-001'] = checkSyntaxValid(instrumented);
  if (enabled.nds003) results['NDS-003'] = checkNonInstrumentationLinesUnchanged(original, instrumented);
  if (enabled.nds004) results['NDS-004'] = checkPublicApiPreserved(original, instrumented);
  if (enabled.nds005) results['NDS-005'] = checkErrorHandlingPreserved(original, instrumented);
  if (enabled.api001) results['API-001'] = checkOtelImportsApiOnly(instrumented);
  if (enabled.cdq001) results['CDQ-001'] = checkSpansClosed(instrumented);
  if (enabled.cdq002) results['CDQ-002'] = checkTracerAcquired(instrumented);
  if (enabled.cdq003) results['CDQ-003'] = checkErrorRecording(instrumented);
  if (enabled.cdq005) results['CDQ-005'] = checkAsyncContext(instrumented);
  if (enabled.cdq007) results['CDQ-007'] = checkAttributeSafety(instrumented);

  return results;
}

describe.skipIf(!API_KEY_AVAILABLE)('Acceptance Gate — Phase 1', () => {
  const resolvedSchema = API_KEY_AVAILABLE ? loadResolvedSchema() : {};
  const config = makeConfig();

  describe('user-routes.js — Express routes with pg', () => {
    it('instruments successfully and passes all rubric checks', { timeout: 240_000 }, async () => {
      const original = loadFixture('src/user-routes.js');
      const filePath = '/project/src/user-routes.js';

      const result = await instrumentFile(filePath, original, resolvedSchema, config, new JavaScriptProvider());

      // Instrumentation should succeed
      expect(result.success).toBe(true);
      if (!result.success) {
        throw new Error(`instrumentFile failed: ${result.error}`);
      }

      const output = result.output;

      // InstrumentationOutput fields should be populated (DX criterion)
      expect(output.instrumentedCode).toBeTruthy();
      expect(output.instrumentedCode.length).toBeGreaterThan(original.length);
      expect(output.notes.length).toBeGreaterThan(0);
      expect(output.tokenUsage.inputTokens).toBeGreaterThan(0);
      expect(output.tokenUsage.outputTokens).toBeGreaterThan(0);
      expect(output.spanCategories).not.toBeNull();

      // Run all rubric checks
      const checks = runRubricChecks(original, output.instrumentedCode);
      for (const [rule, check] of Object.entries(checks)) {
        expect(check.passed, `${rule} failed: ${check.details}`).toBe(true);
      }

      // Auto-instrumentation library detection: pg and express should be detected
      const pgLib = output.librariesNeeded.find(l => l.package.includes('pg'));
      const expressLib = output.librariesNeeded.find(l => l.package.includes('express'));
      expect(pgLib || expressLib).toBeTruthy();
    });
  });

  // order-service.js single-shot removed: P3-2 covers the same file through the fix loop
  // (which is how the agent works in production). Single-shot was flaky due to LLM
  // non-determinism on NDS-003 and added ~49s of API cost without unique coverage.

  describe('format-helpers.js — pure utilities', () => {
    it('instruments with minimal or no spans on utility functions', { timeout: 120_000 }, async () => {
      const original = loadFixture('src/format-helpers.js');
      const filePath = '/project/src/format-helpers.js';

      const result = await instrumentFile(filePath, original, resolvedSchema, config, new JavaScriptProvider());

      expect(result.success).toBe(true);
      if (!result.success) {
        throw new Error(`instrumentFile failed: ${result.error}`);
      }

      const output = result.output;

      // Sync-only pre-screening: format-helpers.js has no async exports, so
      // instrumentFile short-circuits before calling the LLM. The file is
      // returned unchanged with 0 spans and 0 token cost.
      expect(output.notes.length).toBeGreaterThan(0);
      expect(output.notes.some(n => n.toLowerCase().includes('sync'))).toBe(true);
      expect(output.tokenUsage.inputTokens).toBe(0);
      expect(output.instrumentedCode).toBe(original);
      expect(output.schemaExtensions).toEqual([]);
      expect(output.attributesCreated).toBe(0);
    });
  });

  describe('registry-first attribute selection (PRD #581)', () => {
    // Fixture: async function that makes an HTTP fetch call. No OTel imports.
    const httpFixture = `
async function fetchProduct(productId, method) {
  const response = await fetch(\`https://api.store.com/products/\${productId}\`, {
    method: method || 'GET',
  });
  const statusCode = response.status;
  const data = await response.json();
  return { data, statusCode };
}

module.exports = { fetchProduct };
`.trimStart();

    it('Test A: agent uses registry attribute dd.http.request.method instead of inventing', { timeout: 240_000 }, async () => {
      // Schema contains dd.http.request.method and a span definition covering HTTP calls.
      // Agent should select the registered key and produce zero schema extensions.
      const schemaA = {
        groups: [
          {
            id: 'span.dd.http.client',
            type: 'span',
            brief: 'Outbound HTTP client request',
            attributes: [
              { name: 'dd.http.request.method', type: 'string', brief: 'HTTP method used for the request (GET, POST, etc.)' },
              { name: 'dd.http.response.status_code', type: 'int', brief: 'HTTP response status code' },
            ],
          },
        ],
      };

      const result = await instrumentFile(
        '/project/src/fetch-product.js',
        httpFixture,
        schemaA,
        makeConfig(),
        new JavaScriptProvider(),
      );

      expect(result.success).toBe(true);
      if (!result.success) throw new Error(`instrumentFile failed: ${result.error}`);

      const output = result.output;
      expect(output.schemaExtensions).toEqual([]);
      expect(output.instrumentedCode).toContain("setAttribute('dd.http.request.method'");
    });

    it('Test B: agent invents attributes with dd. namespace when only dd.* attributes exist in registry', { timeout: 240_000 }, async () => {
      // Schema has only dd.* attributes, no HTTP-specific one.
      // Agent must invent an HTTP attribute — it must start with dd.
      const schemaB = {
        groups: [
          {
            id: 'dd.service',
            type: 'attribute_group',
            brief: 'Service identity attributes',
            attributes: [
              { name: 'dd.service.name', type: 'string', brief: 'Name of the service' },
              { name: 'dd.service.version', type: 'string', brief: 'Version of the service' },
            ],
          },
        ],
      };

      const result = await instrumentFile(
        '/project/src/fetch-product.js',
        httpFixture,
        schemaB,
        makeConfig(),
        new JavaScriptProvider(),
      );

      expect(result.success).toBe(true);
      if (!result.success) throw new Error(`instrumentFile failed: ${result.error}`);

      const output = result.output;
      // Any attribute extensions (schemaExtensions entries not starting with 'span.')
      // must start with 'dd.' — matching the registry's established namespace.
      const attributeExtensions = output.schemaExtensions.filter(e => !e.startsWith('span.'));
      for (const ext of attributeExtensions) {
        expect(ext, `Attribute extension '${ext}' should start with 'dd.' to match registry namespace`).toMatch(/^dd\./);
      }
    });
  });

  describe('already-instrumented.js — RST-005', () => {
    it('detects existing instrumentation and skips without LLM call', async () => {
      const original = loadFixture('src/already-instrumented.js');
      const filePath = '/project/src/already-instrumented.js';

      const result = await instrumentFile(filePath, original, resolvedSchema, config, new JavaScriptProvider());

      // Should succeed (skip is a success, not a failure)
      expect(result.success).toBe(true);
      if (!result.success) {
        throw new Error(`instrumentFile failed: ${result.error}`);
      }

      const output = result.output;

      // Code should be unchanged — returned as-is
      expect(output.instrumentedCode).toBe(original);

      // Token usage should be zero (no API call made)
      expect(output.tokenUsage.inputTokens).toBe(0);
      expect(output.tokenUsage.outputTokens).toBe(0);

      // Notes should explain the skip
      expect(output.notes.length).toBeGreaterThan(0);
      expect(output.notes.some(n => n.toLowerCase().includes('already instrumented'))).toBe(true);

      // spanCategories should be null (no new spans)
      expect(output.spanCategories).toBeNull();
    });
  });
});

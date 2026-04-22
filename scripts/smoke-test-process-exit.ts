// ABOUTME: Targeted smoke test for the process.exit() instrumentation fix.
// ABOUTME: Calls the real Anthropic API (~3-5 min). Run this before triggering the full acceptance gate.
//
// Usage:
//   vals exec -f .vals.yaml -- bash -c 'export PATH="/opt/homebrew/bin:$PATH" && npx tsx scripts/smoke-test-process-exit.ts'
//
// Exit 0: fix is working — agent instruments gatherData/saveResult, not main()
// Exit 1: fix is NOT working — log shows what went wrong

import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { instrumentWithRetry } from '../src/fix-loop/instrument-with-retry.ts';
import type { AgentConfig } from '../src/config/schema.ts';

const FIXTURE_PATH = join(import.meta.dirname, '..', 'test', 'fixtures', 'smoke', 'process-exit-instrumentation.js');

function makeConfig(): AgentConfig {
  return {
    schemaPath: './telemetry/registry',
    sdkInitFile: './src/telemetry.ts',
    agentModel: 'claude-sonnet-4-6',
    agentEffort: 'medium',
    autoApproveLibraries: true,
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
  };
}

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY not set — wrap with vals exec');
    process.exit(1);
  }

  const originalCode = readFileSync(FIXTURE_PATH, 'utf-8');
  const tempDir = mkdtempSync(join(tmpdir(), 'spiny-smoke-'));
  const filePath = join(tempDir, 'process-exit-instrumentation.js');

  try {
    writeFileSync(filePath, originalCode, 'utf-8');
    console.log(`Fixture: ${FIXTURE_PATH}`); // eslint-disable-line no-console
    console.log(`Temp file: ${filePath}`); // eslint-disable-line no-console
    console.log('Calling instrumentWithRetry with real API...'); // eslint-disable-line no-console

    const result = await instrumentWithRetry(filePath, originalCode, {}, makeConfig());

    console.log('\n--- Result ---'); // eslint-disable-line no-console
    console.log(`status:             ${result.status}`); // eslint-disable-line no-console
    console.log(`spansAdded:         ${result.spansAdded}`); // eslint-disable-line no-console
    console.log(`validationAttempts: ${result.validationAttempts}`); // eslint-disable-line no-console
    console.log(`errorProgression:   ${JSON.stringify(result.errorProgression)}`); // eslint-disable-line no-console

    if (result.advisoryAnnotations && result.advisoryAnnotations.length > 0) {
      console.log('\nAdvisory findings:'); // eslint-disable-line no-console
      for (const a of result.advisoryAnnotations) {
        console.log(`  [${a.ruleId}] ${a.message.slice(0, 120)}`); // eslint-disable-line no-console
      }
    } else {
      console.log('advisoryAnnotations: none'); // eslint-disable-line no-console
    }

    // Check 1: instrumentation succeeded
    if (result.status !== 'success') {
      console.error(`\nFAIL: status is "${result.status}", expected "success"`);
      if (result.reason) console.error(`reason: ${result.reason}`);
      if (result.lastError) console.error(`lastError: ${result.lastError}`);
      process.exit(1);
    }

    // Check 2: at least 2 spans added (gatherData + saveResult)
    if (result.spansAdded < 2) {
      console.error(`\nFAIL: spansAdded is ${result.spansAdded}, expected >= 2`);
      console.error('The agent should have instrumented gatherData and saveResult.');
      process.exit(1);
    }

    // Check 3: no COV-004 finding — main() must NOT have been flagged
    const cov004Findings = (result.advisoryAnnotations ?? []).filter((a) => a.ruleId === 'COV-004');
    if (cov004Findings.length > 0) {
      console.error(`\nFAIL: COV-004 still fired ${cov004Findings.length} time(s)`);
      for (const f of cov004Findings) {
        console.error(`  ${f.message}`);
      }
      console.error('main() should be exempt from COV-004 (process.exit() exemption).');
      process.exit(1);
    }

    console.log('\nPASS: fix is working correctly'); // eslint-disable-line no-console
    console.log('  - Instrumentation succeeded'); // eslint-disable-line no-console
    console.log(`  - ${result.spansAdded} span(s) added (gatherData and/or saveResult)`); // eslint-disable-line no-console
    console.log('  - COV-004 did not fire for main() (process.exit() exemption active)'); // eslint-disable-line no-console
  } finally {
    if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((err: unknown) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});

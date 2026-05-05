// ABOUTME: Generates the temporary gRPC SDK init file for live-check test runs.
// ABOUTME: Checks @opentelemetry/sdk-node availability and provides the NodeSDK init template.

import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { constants } from 'node:fs';

/** Filename written into the target project's root directory before the live-check test run. */
export const LIVE_CHECK_INIT_FILENAME = '.spiny-orb-live-check-init.mjs';

/**
 * Generate the content of the temporary SDK init file.
 *
 * Uses NodeSDK (not NodeTracerProvider) because only @opentelemetry/sdk-node is
 * guaranteed to be in the target project's top-level node_modules. In pnpm strict
 * mode, transitive packages like sdk-trace-node and exporter-trace-otlp-grpc are
 * NOT hoisted to the top level — importing them as bare specifiers fails.
 *
 * NodeSDK resolves the gRPC exporter from its own transitive deps when
 * OTEL_EXPORTER_OTLP_PROTOCOL=grpc is set in the environment.
 *
 * Double-init detection: monkeypatch trace.setGlobalTracerProvider before calling
 * sdk.start() to capture the return value NodeSDK produces internally.
 */
export function generateInitFileContent(serviceName: string): string {
  const safe = serviceName.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  return `// spiny-orb live-check SDK init — temporary file, deleted after live-check run
// Resolves @opentelemetry/sdk-node from this project's node_modules.
import { NodeSDK } from '@opentelemetry/sdk-node';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { trace } from '@opentelemetry/api';
// OTEL_EXPORTER_OTLP_PROTOCOL=grpc and OTEL_EXPORTER_OTLP_ENDPOINT are set in env
// NodeSDK auto-selects @opentelemetry/exporter-trace-otlp-grpc from its own deps

const sdk = new NodeSDK({
  resource: resourceFromAttributes({ 'service.name': '${safe}' }),
});

// Double-init detection: intercept the setGlobalTracerProvider call NodeSDK makes
// internally during start() to capture its return value (false = already registered).
let registrationSucceeded = false;
const _origSetProvider = trace.setGlobalTracerProvider.bind(trace);
trace.setGlobalTracerProvider = (provider) => {
  const result = _origSetProvider(provider);
  registrationSucceeded = result;
  trace.setGlobalTracerProvider = _origSetProvider;
  return result;
};

sdk.start();

if (registrationSucceeded) {
  // beforeExit fires when the event loop empties; calling sdk.shutdown() here re-enters
  // the event loop via async gRPC export, ensuring spans are flushed before process exits.
  let _shutdownStarted = false;
  process.on('beforeExit', () => {
    if (!_shutdownStarted) {
      _shutdownStarted = true;
      sdk.shutdown().catch(() => {});
    }
  });
  process.on('SIGTERM', async () => { await sdk.shutdown(); process.exit(143); });
  process.on('SIGINT', async () => { await sdk.shutdown(); process.exit(130); });
} else {
  // A non-default provider is already active — shut down to avoid resource leaks
  sdk.shutdown().catch(() => {});
}
`;
}

/**
 * Check if @opentelemetry/sdk-node is available in the target project's node_modules.
 * If not available, SDK injection should be skipped.
 */
export async function checkSdkNodeAvailable(
  projectDir: string,
  accessFn: (path: string, mode: number) => Promise<void> = (p, m) => access(p, m),
): Promise<boolean> {
  const sdkNodePath = join(projectDir, 'node_modules', '@opentelemetry', 'sdk-node');
  try {
    await accessFn(sdkNodePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

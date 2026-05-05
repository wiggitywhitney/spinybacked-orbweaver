// ABOUTME: Generates the temporary gRPC SDK init file for live-check test runs.
// ABOUTME: Checks @opentelemetry/sdk-node availability and provides the NodeTracerProvider init template.

import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { constants } from 'node:fs';

/** Filename written into the target project's root directory before the live-check test run. */
export const LIVE_CHECK_INIT_FILENAME = '.spiny-orb-live-check-init.mjs';

/**
 * Generate the content of the temporary SDK init file.
 *
 * Uses NodeTracerProvider (not NodeSDK) so we can call trace.setGlobalTracerProvider()
 * directly and check its return value for double-init detection.
 * OTLPTraceExporter reads OTEL_EXPORTER_OTLP_ENDPOINT from the environment.
 */
export function generateInitFileContent(serviceName: string): string {
  const safe = serviceName.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  return `// spiny-orb live-check SDK init — temporary file, deleted after live-check run
// Resolves packages from this project's node_modules.
import { trace } from '@opentelemetry/api';
import { NodeTracerProvider, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { resourceFromAttributes } from '@opentelemetry/resources';
// OTEL_EXPORTER_OTLP_ENDPOINT is read from the environment by OTLPTraceExporter

const exporter = new OTLPTraceExporter();
const provider = new NodeTracerProvider({
  resource: resourceFromAttributes({ 'service.name': '${safe}' }),
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});

// Double-init detection: setGlobalTracerProvider returns false if already registered
const registered = trace.setGlobalTracerProvider(provider);
if (registered) {
  process.on('SIGTERM', async () => { await provider.shutdown(); process.exit(143); });
  process.on('SIGINT', async () => { await provider.shutdown(); process.exit(130); });
} else {
  // A non-default provider is already active — shut down ours to avoid resource leaks
  provider.shutdown().catch(() => {});
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

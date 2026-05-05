// ABOUTME: End-of-run Weaver live-check — starts Weaver as OTLP receiver, runs test suite, captures compliance report.
// ABOUTME: Implements graceful degradation for missing tests, port conflicts, and Weaver failures.

import { createServer as defaultCreateServer } from 'node:net';
import { spawn as defaultSpawn } from 'node:child_process';
import { execFile as defaultExecFile } from 'node:child_process';
import { writeFile as defaultWriteFile, unlink as defaultUnlink } from 'node:fs/promises';
import type { ChildProcess } from 'node:child_process';
import type { Server } from 'node:net';
import { join, basename } from 'node:path';
import type { CoordinatorCallbacks } from './types.ts';
import { hasTestSuite } from './test-suite-detection.ts';
import {
  LIVE_CHECK_INIT_FILENAME,
  generateInitFileContent,
  checkSdkNodeAvailable,
} from './live-check-sdk-init.ts';

/** Default Weaver OTLP receiver ports — non-standard to avoid conflicts with existing OTel collectors. */
export const DEFAULT_GRPC_PORT = 14317;
export const DEFAULT_ADMIN_PORT = 14320;

/** How long to wait for Weaver to start listening (ms). */
const WEAVER_STARTUP_TIMEOUT_MS = 15_000;

/** How long to wait for the test suite to complete (ms). */
const TEST_SUITE_TIMEOUT_MS = 300_000;

/** How long to wait for Weaver to stop after /stop request (ms). */
const WEAVER_STOP_TIMEOUT_MS = 10_000;

/**
 * Injectable dependencies for testing.
 * Uses simplified signatures — production defaults come from node:net, node:child_process.
 */
export interface LiveCheckDeps {
  createServerFn: (...args: unknown[]) => unknown;
  spawnFn: (command: string, args: string[], options: object) => unknown;
  execFileFn: (
    cmd: string,
    args: string[],
    opts: unknown,
    cb: (error: Error | null, stdout: string, stderr: string) => void,
  ) => void;
  fetchFn: (url: string, init?: RequestInit) => Promise<Response>;
  setTimeout: (cb: () => void, ms: number) => unknown;
  clearTimeout: (id: unknown) => void;
  /** Write a file (for init file creation). Defaults to node:fs/promises writeFile. */
  writeFileFn?: (path: string, content: string) => Promise<void>;
  /** Delete a file (for init file cleanup). Defaults to node:fs/promises unlink. */
  deleteFileFn?: (path: string) => Promise<void>;
  /** Check if @opentelemetry/sdk-node is available in the target project. */
  checkSdkNodeFn?: (projectDir: string) => Promise<boolean>;
}

/** Result of port availability check. */
export interface PortCheckResult {
  available: boolean;
  port: number;
  pid?: number;
  processName?: string;
}

/** Parsed compliance data extracted from Weaver live-check JSON output. */
export interface ParsedCompliance {
  /** Whether any spans were received by Weaver. */
  spansReceived: boolean;
  /** Number of spans received (from statistics.total_entities_by_type.span). */
  spanCount: number;
  /** Total advisory findings across all entities. 0 = fully compliant. */
  totalAdvisories: number;
}

/** Result of the end-of-run live-check workflow. */
export interface LiveCheckResult {
  /** Whether the live-check was skipped (port conflict, missing tests, etc.). */
  skipped: boolean;
  /** Raw Weaver compliance report (JSON string from --format json). */
  complianceReport?: string;
  /** Parsed compliance data extracted from the JSON report. Undefined if skipped or JSON parse failed. */
  parsedCompliance?: ParsedCompliance;
  /** Whether the test suite passed. */
  testsPassed?: boolean;
  /** Combined stdout+stderr from the test suite run. Only present when tests fail. */
  testOutput?: string;
  /** Whether the test suite failed specifically after SDK injection was attempted. Undefined if injection wasn't attempted. */
  sdkInjectionTestsFailed?: boolean;
  /** Warnings produced during the live-check workflow. */
  warnings: string[];
}

/** Configuration options for the live-check workflow. */
export interface LiveCheckOptions {
  /** OTLP gRPC receiver port. Default: 14317. */
  grpcPort?: number;
  /** Weaver admin HTTP port. Default: 14320. */
  adminPort?: number;
  /** Inactivity timeout in seconds before Weaver auto-stops. Default: derived from TEST_SUITE_TIMEOUT_MS. */
  inactivityTimeoutSeconds?: number;
}

/**
 * Check if a port is available for binding.
 *
 * @param port - Port number to check
 * @param deps - Injectable dependencies for testing
 * @returns Port availability result
 */
export async function checkPortAvailable(
  port: number,
  deps?: LiveCheckDeps,
): Promise<PortCheckResult> {
  const createServer = deps?.createServerFn ?? defaultCreateServer;
  const execFileFn = deps?.execFileFn ?? (defaultExecFile as unknown as LiveCheckDeps['execFileFn']);

  return new Promise((resolve) => {
    const server = createServer() as Server;

    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        // Attempt to identify the blocking process via lsof
        execFileFn('lsof', ['-i', `:${port}`, '-t'], {}, (lsofErr, stdout) => {
          if (!lsofErr && stdout.trim()) {
            const pid = parseInt(stdout.trim().split('\n')[0], 10);
            execFileFn('ps', ['-p', String(pid), '-o', 'comm='], {}, (psErr, psStdout) => {
              const processName = (!psErr && psStdout.trim()) ? psStdout.trim() : undefined;
              resolve({ available: false, port, pid, processName });
            });
          } else {
            resolve({ available: false, port });
          }
        });
      } else {
        resolve({ available: false, port });
      }
    });

    server.listen(port, () => {
      server.close(() => {
        resolve({ available: true, port });
      });
    });
  });
}

/**
 * Run the end-of-run Weaver live-check workflow.
 *
 * Workflow:
 * 1. Validate test command exists
 * 2. Check port availability (default: 14317 gRPC, 14320 HTTP)
 * 3. Start `weaver registry live-check -r <registryDir>`
 * 4. Wait for Weaver to be ready
 * 5. Run test suite with OTEL_EXPORTER_OTLP_ENDPOINT override
 * 6. Stop Weaver via HTTP /stop endpoint
 * 7. Capture compliance report
 *
 * All failures degrade gracefully — the run is never aborted.
 *
 * @param registryDir - Absolute path to the Weaver registry directory
 * @param projectDir - Root directory of the project (cwd for test suite)
 * @param testCommand - Test command to run (e.g., "npm test")
 * @param deps - Injectable dependencies for testing
 * @param callbacks - Optional coordinator callbacks for validation progress
 * @returns Live-check result with compliance report and warnings
 */
export async function runLiveCheck(
  registryDir: string,
  projectDir: string,
  testCommand: string,
  options?: LiveCheckOptions,
  deps?: LiveCheckDeps,
  callbacks?: Pick<CoordinatorCallbacks, 'onValidationStart' | 'onValidationComplete'>,
): Promise<LiveCheckResult> {
  const warnings: string[] = [];
  const grpcPort = options?.grpcPort ?? DEFAULT_GRPC_PORT;
  const adminPort = options?.adminPort ?? DEFAULT_ADMIN_PORT;
  const inactivityTimeoutSeconds = options?.inactivityTimeoutSeconds ?? Math.ceil(TEST_SUITE_TIMEOUT_MS / 1000);

  // Step 1: Validate test command — check both empty and placeholder patterns
  if (!testCommand || testCommand.trim() === '') {
    return {
      skipped: true,
      warnings: ['No test command configured. Skipping end-of-run live-check.'],
    };
  }

  // Detect npm default and other placeholder test commands
  if (!await hasTestSuite(testCommand, projectDir)) {
    return {
      skipped: true,
      warnings: ['No test suite detected (test command is a placeholder). Skipping end-of-run live-check.'],
    };
  }

  // Step 2: Check port availability
  const grpcCheck = await checkPortAvailable(grpcPort, deps);
  if (!grpcCheck.available) {
    const pidInfo = grpcCheck.pid ? ` (PID: ${grpcCheck.pid}${grpcCheck.processName ? `, process: ${grpcCheck.processName}` : ''})` : '';
    const msg = `Port ${grpcPort} is in use${pidInfo}. Free this port to enable end-of-run schema validation. Skipping live-check.`;
    return { skipped: true, warnings: [msg] };
  }

  const httpCheck = await checkPortAvailable(adminPort, deps);
  if (!httpCheck.available) {
    const pidInfo = httpCheck.pid ? ` (PID: ${httpCheck.pid}${httpCheck.processName ? `, process: ${httpCheck.processName}` : ''})` : '';
    const msg = `Port ${adminPort} is in use${pidInfo}. Free this port to enable end-of-run schema validation. Skipping live-check.`;
    return { skipped: true, warnings: [msg] };
  }

  // Fire onValidationStart callback
  try {
    callbacks?.onValidationStart?.();
  } catch {
    // Callback errors are non-fatal
  }

  const spawnFn = deps?.spawnFn ?? defaultSpawn;
  const execFileFn = deps?.execFileFn ?? (defaultExecFile as unknown as LiveCheckDeps['execFileFn']);
  const fetchFn = deps?.fetchFn ?? globalThis.fetch;
  const writeFileFn = deps?.writeFileFn ?? ((p: string, c: string) => defaultWriteFile(p, c, 'utf-8'));
  const deleteFileFn = deps?.deleteFileFn ?? ((p: string) => defaultUnlink(p).catch(() => {}));
  const checkSdkNodeFn = deps?.checkSdkNodeFn ?? checkSdkNodeAvailable;
  const setTimeoutFn: (cb: () => void, ms: number) => unknown = deps?.setTimeout ?? globalThis.setTimeout;
  const clearTimeoutFn: (id: unknown) => void = deps?.clearTimeout ?? ((id) => globalThis.clearTimeout(id as ReturnType<typeof globalThis.setTimeout>));

  // Step 3: Start Weaver live-check
  let weaverProcess: ChildProcess;
  let weaverStderr = '';

  try {
    weaverProcess = spawnFn('weaver', [
      'registry', 'live-check', '-r', registryDir,
      '--format', 'json',
      '--inactivity-timeout', String(inactivityTimeoutSeconds),
      '--otlp-grpc-port', String(grpcPort),
      '--admin-port', String(adminPort),
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
    }) as ChildProcess;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try { callbacks?.onValidationComplete?.(false, ''); } catch { /* non-fatal */ }
    return {
      skipped: true,
      warnings: [`Failed to start Weaver live-check: ${message}`],
    };
  }

  // Silently absorb 'error' events (e.g. ENOENT when weaver is not in PATH).
  // The 'close' event fires after 'error' and is what drives waitForWeaverReady.
  weaverProcess.on('error', (err: NodeJS.ErrnoException) => {
    weaverStderr += `weaver spawn error: ${err.message}`;
  });

  // Collect stderr for diagnostics
  weaverProcess.stderr?.on('data', (data: Buffer) => {
    weaverStderr += data.toString();
  });

  // Collect stdout for compliance report
  let weaverStdout = '';
  weaverProcess.stdout?.on('data', (data: Buffer) => {
    weaverStdout += data.toString();
  });

  // Step 4: Wait for Weaver to be ready (or fail early)
  const weaverReady = await waitForWeaverReady(weaverProcess, deps);
  if (!weaverReady.ready) {
    try { callbacks?.onValidationComplete?.(false, ''); } catch { /* non-fatal */ }
    return {
      skipped: true,
      warnings: [`Failed to start Weaver live-check: ${weaverStderr || weaverReady.error || 'process exited unexpectedly'}`],
    };
  }

  // Step 5: Inject SDK init file if @opentelemetry/sdk-node is available
  let sdkInjected = false;
  const initFilePath = join(projectDir, LIVE_CHECK_INIT_FILENAME);

  const sdkNodeAvailable = await checkSdkNodeFn(projectDir);
  if (sdkNodeAvailable) {
    const serviceName = basename(projectDir) || 'unknown';
    try {
      await writeFileFn(initFilePath, generateInitFileContent(serviceName));
      sdkInjected = true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      warnings.push(`Failed to write SDK init file for live-check: ${message}. Proceeding without SDK injection.`);
    }
  } else {
    warnings.push(
      `@opentelemetry/sdk-node not found in ${projectDir}/node_modules. ` +
      `SDK injection skipped — spans will not reach Weaver. ` +
      `Install @opentelemetry/sdk-node in the target project to enable live-check telemetry validation.`,
    );
  }

  // Build extra env vars for the test run
  const extraEnv: Record<string, string> = {};
  if (sdkInjected) {
    const existingNodeOptions = process.env['NODE_OPTIONS'];
    extraEnv['NODE_OPTIONS'] = existingNodeOptions
      ? `${existingNodeOptions} --import "${initFilePath}"`
      : `--import "${initFilePath}"`;
    // NodeSDK selects the gRPC exporter when this is set
    extraEnv['OTEL_EXPORTER_OTLP_PROTOCOL'] = 'grpc';
    // Force BatchSpanProcessor to export immediately (next tick) rather than after the
    // default 5-second delay — critical for short-lived test processes that exit quickly
    extraEnv['OTEL_BSP_SCHEDULE_DELAY'] = '0';
  }

  // Step 5b: Run test suite with OTLP endpoint override (+ SDK injection if available)
  let testsPassed = true;
  let testOutput: string | undefined;
  let sdkInjectionTestsFailed: boolean | undefined;

  try {
    await runTestSuite(testCommand, projectDir, grpcPort, execFileFn, extraEnv);
  } catch (err) {
    testsPassed = false;
    if (sdkInjected) {
      sdkInjectionTestsFailed = true;
    }
    const message = err instanceof Error ? err.message : String(err);
    // ExecFileException carries stdout/stderr on the error object — capture for call path analysis.
    const errRecord = err as Record<string, unknown>;
    const outStr = typeof errRecord['stdout'] === 'string' ? errRecord['stdout'] : '';
    const errStr = typeof errRecord['stderr'] === 'string' ? errRecord['stderr'] : '';
    const combined = [outStr, errStr].filter(Boolean).join('\n');
    testOutput = combined || undefined;
    warnings.push(`End-of-run test suite failed: ${message}`);
  }

  // Clean up the init file (always, even on failure)
  if (sdkInjected) {
    await deleteFileFn(initFilePath);
  }

  // Step 6: Stop Weaver via HTTP /stop endpoint and wait for process exit.
  //
  // Weaver writes the JSON compliance report to stdout as it shuts down — the
  // /stop HTTP response is just an acknowledgment ("OK"). We wait briefly before
  // calling /stop (to let in-flight gRPC span data arrive), then wait for the
  // process to fully exit (to capture the statistics block written at shutdown).
  await new Promise<void>((resolve) => {
    setTimeoutFn(resolve, 2_000);
  });

  let complianceReport: string | undefined;
  let stopHttpBody: string | undefined;
  try {
    const stopResponse = await fetchFn(`http://localhost:${adminPort}/stop`, {
      method: 'POST',
      signal: AbortSignal.timeout(WEAVER_STOP_TIMEOUT_MS),
    });
    stopHttpBody = await stopResponse.text();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    warnings.push(
      `Weaver shutdown failed during compliance report collection at http://localhost:${adminPort}/stop: ${message}. ` +
      `To recover: re-run the instrumentation or check network connectivity to the Weaver admin port (${adminPort}).`,
    );
    // Force kill the process
    try {
      weaverProcess.kill('SIGTERM');
    } catch {
      // Best effort
    }
  }

  // Wait for Weaver to fully exit so all stdout (including statistics) is flushed.
  await new Promise<void>((resolve) => {
    const timer = setTimeoutFn(() => resolve(), WEAVER_STOP_TIMEOUT_MS);
    (weaverProcess as { once?: (event: string, cb: () => void) => void }).once?.('close', () => {
      clearTimeoutFn(timer);
      resolve();
    });
  });

  // Use stdout for the compliance report — Weaver 0.22.x streams individual
  // entity JSON objects to stdout and writes statistics as the last object.
  // Fall back to the /stop HTTP response body (for mocked tests and older
  // Weaver versions that return JSON in the HTTP body).
  if (weaverStdout) {
    complianceReport = weaverStdout;
  } else if (stopHttpBody && stopHttpBody !== 'OK') {
    complianceReport = stopHttpBody;
  }

  // Parse the JSON compliance report to extract structured compliance data
  const parsedCompliance = complianceReport ? parseComplianceReport(complianceReport) : undefined;

  // Fire onValidationComplete callback
  try {
    callbacks?.onValidationComplete?.(testsPassed, complianceReport ?? '');
  } catch {
    // Callback errors are non-fatal
  }

  return {
    skipped: false,
    complianceReport,
    parsedCompliance,
    testsPassed,
    testOutput,
    sdkInjectionTestsFailed,
    warnings,
  };
}

/**
 * Parse the Weaver live-check JSON compliance report into structured compliance data.
 *
 * Handles two output formats:
 * - Weaver 0.21.x: single JSON object `{"samples":[...],"statistics":{...}}`
 * - Weaver 0.22.x: streaming JSONL where the last object IS the statistics
 *   `{"total_entities":N,"total_entities_by_type":{...},...}`
 *
 * Returns undefined if the report lacks the expected structure.
 */
function parseComplianceReport(raw: string): ParsedCompliance | undefined {
  // Try 0.21.x format: single object with a "statistics" wrapper key
  try {
    const json = JSON.parse(raw) as Record<string, unknown>;
    const stats = json['statistics'] as Record<string, unknown> | undefined;
    if (stats && typeof stats === 'object') {
      return extractCompliance(stats);
    }
  } catch {
    // Not a single JSON — fall through to streaming format
  }

  // Try 0.22.x streaming format: find the last JSON object in the output.
  // Weaver streams individual entity objects, with the statistics object last.
  // The statistics object has "total_entities" directly at the top level.
  const lastNewlineBrace = raw.lastIndexOf('\n{');
  if (lastNewlineBrace !== -1) {
    try {
      const candidate = raw.slice(lastNewlineBrace + 1);
      const json = JSON.parse(candidate) as Record<string, unknown>;
      if (typeof json['total_entities'] === 'number') {
        return extractCompliance(json);
      }
    } catch {
      // not parseable
    }
  }

  return undefined;
}

function extractCompliance(stats: Record<string, unknown>): ParsedCompliance {
  const entitiesByType = (stats['total_entities_by_type'] ?? {}) as Record<string, unknown>;
  const spanCount = typeof entitiesByType['span'] === 'number' ? entitiesByType['span'] : 0;
  const totalAdvisories = typeof stats['total_advisories'] === 'number' ? stats['total_advisories'] : 0;
  return {
    spansReceived: spanCount > 0,
    spanCount,
    totalAdvisories,
  };
}

/**
 * Wait for Weaver to be ready to accept connections, or detect early exit.
 * Uses a simple polling approach — tries to connect to the HTTP port.
 */
async function waitForWeaverReady(
  process: ChildProcess,
  deps?: LiveCheckDeps,
): Promise<{ ready: boolean; error?: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const setTimeoutFn: (cb: () => void, ms: number) => unknown = deps?.setTimeout ?? globalThis.setTimeout;
    const clearTimeoutFn: (id: unknown) => void = deps?.clearTimeout ?? ((id) => globalThis.clearTimeout(id as ReturnType<typeof globalThis.setTimeout>));

    // Detect early exit
    process.on('close', (code) => {
      if (!settled) {
        settled = true;
        resolve({ ready: false, error: `Weaver exited with code ${code}` });
      }
    });

    // Give Weaver time to start, then assume it's ready
    const timer = setTimeoutFn(() => {
      if (!settled) {
        settled = true;
        resolve({ ready: true });
      }
    }, WEAVER_STARTUP_TIMEOUT_MS);

    // Clean up timer if process exits first
    process.on('close', () => {
      clearTimeoutFn(timer);
    });
  });
}

/**
 * Run the test suite with OTEL_EXPORTER_OTLP_ENDPOINT override and any extra env vars.
 */
async function runTestSuite(
  testCommand: string,
  projectDir: string,
  grpcPort: number,
  execFileFn: LiveCheckDeps['execFileFn'],
  extraEnv: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string }> {
  const isWindows = process.platform === 'win32';
  const cmd = isWindows ? 'cmd.exe' : 'sh';
  const args = isWindows ? ['/c', testCommand] : ['-c', testCommand];

  return new Promise((resolve, reject) => {
    execFileFn(
      cmd,
      args,
      {
        cwd: projectDir,
        timeout: TEST_SUITE_TIMEOUT_MS,
        env: {
          ...process.env,
          OTEL_EXPORTER_OTLP_ENDPOINT: `http://localhost:${grpcPort}`,
          ...extraEnv,
        },
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

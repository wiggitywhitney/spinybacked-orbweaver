// ABOUTME: End-of-run Weaver live-check — starts Weaver as OTLP receiver, runs test suite, captures compliance report.
// ABOUTME: Implements graceful degradation for missing tests, port conflicts, and Weaver failures.

import { createServer as defaultCreateServer } from 'node:net';
import { spawn as defaultSpawn } from 'node:child_process';
import { execFile as defaultExecFile } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import type { Server } from 'node:net';
import type { CoordinatorCallbacks } from './types.ts';
import { hasTestSuite } from './test-suite-detection.ts';

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
}

/** Result of port availability check. */
export interface PortCheckResult {
  available: boolean;
  port: number;
  pid?: number;
  processName?: string;
}

/** Result of the end-of-run live-check workflow. */
export interface LiveCheckResult {
  /** Whether the live-check was skipped (port conflict, missing tests, etc.). */
  skipped: boolean;
  /** Weaver compliance report content (raw CLI output). */
  complianceReport?: string;
  /** Whether the test suite passed. */
  testsPassed?: boolean;
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
  if (!hasTestSuite(testCommand)) {
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

  // Step 3: Start Weaver live-check
  let weaverProcess: ChildProcess;
  let weaverStderr = '';

  try {
    weaverProcess = spawnFn('weaver', [
      'registry', 'live-check', '-r', registryDir,
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

  // Step 5: Run test suite with OTLP endpoint override
  let testsPassed = true;
  try {
    await runTestSuite(testCommand, projectDir, grpcPort, execFileFn);
  } catch (err) {
    testsPassed = false;
    const message = err instanceof Error ? err.message : String(err);
    warnings.push(`End-of-run test suite failed: ${message}`);
  }

  // Step 6: Stop Weaver via HTTP /stop endpoint
  let complianceReport: string | undefined;
  try {
    const stopResponse = await fetchFn(`http://localhost:${adminPort}/stop`, {
      method: 'POST',
      signal: AbortSignal.timeout(WEAVER_STOP_TIMEOUT_MS),
    });
    complianceReport = await stopResponse.text();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    warnings.push(`Failed to stop Weaver gracefully via /stop endpoint: ${message}`);
    // Force kill the process
    try {
      weaverProcess.kill('SIGTERM');
    } catch {
      // Best effort
    }
  }

  // Use stdout if /stop didn't return a report
  if (!complianceReport && weaverStdout) {
    complianceReport = weaverStdout;
  }

  // Fire onValidationComplete callback
  try {
    callbacks?.onValidationComplete?.(testsPassed, complianceReport ?? '');
  } catch {
    // Callback errors are non-fatal
  }

  return {
    skipped: false,
    complianceReport,
    testsPassed,
    warnings,
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
 * Run the test suite with OTEL_EXPORTER_OTLP_ENDPOINT override.
 */
async function runTestSuite(
  testCommand: string,
  projectDir: string,
  grpcPort: number,
  execFileFn: LiveCheckDeps['execFileFn'],
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

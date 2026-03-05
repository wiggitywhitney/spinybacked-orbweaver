// ABOUTME: Handler for the `orb init` command.
// ABOUTME: Checks prerequisites, detects project type, and creates orb.yaml config file.

import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';

/** Options for the init command. */
interface InitOptions {
  projectDir: string;
  yes: boolean;
}

/** Injectable dependencies for testing. */
interface InitDeps {
  readFile: (path: string) => Promise<string>;
  access: (path: string) => Promise<void>;
  writeFile: (path: string, content: string) => Promise<void>;
  execFileSync: (cmd: string, args: string[], opts?: object) => Buffer;
  globSync: (patterns: string[]) => string[];
  findSchemaDir: (projectDir: string) => string | null;
  prompt: (question: string) => Promise<string>;
  stderr: (msg: string) => void;
  checkPort: (port: number) => Promise<boolean>;
}

/** Result of the init command. */
interface InitResult {
  success: boolean;
  configPath?: string;
  errors: string[];
  warnings: string[];
}

const WEAVER_MIN_VERSION = '0.21.2';
const REQUIRED_PORTS = [4317, 4320];

/** Common OTel SDK init file patterns relative to project root. */
const SDK_INIT_PATTERNS = [
  'src/instrumentation.ts', 'src/instrumentation.js',
  'src/telemetry.ts', 'src/telemetry.js',
  'src/tracing.ts', 'src/tracing.js',
  'src/otel.ts', 'src/otel.js',
  'instrumentation.ts', 'instrumentation.js',
  'tracing.ts', 'tracing.js',
  'src/telemetry/setup.ts', 'src/telemetry/setup.js',
  'src/telemetry/index.ts', 'src/telemetry/index.js',
];

/**
 * Detect project type from package.json contents.
 * Precedence: private: true → service; bin → distributable; main/exports → distributable.
 * Default: service.
 *
 * @param packageJson - Parsed package.json object
 * @returns 'service' or 'distributable'
 */
function detectProjectType(packageJson: Record<string, unknown>): 'service' | 'distributable' {
  if (packageJson.private === true) {
    return 'service';
  }
  if (packageJson.bin !== undefined) {
    return 'distributable';
  }
  if (packageJson.main !== undefined || packageJson.exports !== undefined) {
    return 'distributable';
  }
  return 'service';
}

/**
 * Parse a semver-like version string into comparable parts.
 * Only handles major.minor.patch — sufficient for Weaver version comparison.
 */
function parseVersion(version: string): { major: number; minor: number; patch: number } | null {
  const match = version.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
  };
}

/**
 * Compare two semver versions. Returns true if actual >= required.
 */
function isVersionSatisfied(actual: string, required: string): boolean {
  const act = parseVersion(actual);
  const req = parseVersion(required);
  if (!act || !req) return false;

  if (act.major !== req.major) return act.major > req.major;
  if (act.minor !== req.minor) return act.minor > req.minor;
  return act.patch >= req.patch;
}

/**
 * Run the full init workflow: check prerequisites, detect settings, create config.
 *
 * @param options - Init command options (projectDir, --yes flag)
 * @param deps - Injectable dependencies for testing
 * @returns Structured result with config path on success or error messages
 */
async function handleInit(options: InitOptions, deps: InitDeps): Promise<InitResult> {
  const { projectDir, yes } = options;
  const errors: string[] = [];
  const warnings: string[] = [];
  const configPath = join(projectDir, 'orb.yaml');

  deps.stderr('Checking prerequisites...');

  // Check if orb.yaml already exists
  try {
    await deps.access(configPath);
    errors.push(`orb.yaml already exists at ${configPath}. Remove it first to re-initialize.`);
    return { success: false, errors, warnings };
  } catch {
    // Expected — file should not exist
  }

  // Read and parse package.json
  const packageJsonPath = join(projectDir, 'package.json');
  let packageJson: Record<string, unknown>;
  try {
    const raw = await deps.readFile(packageJsonPath);
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      errors.push(`package.json at ${packageJsonPath} is not a valid JSON object.`);
      return { success: false, errors, warnings };
    }
    packageJson = parsed as Record<string, unknown>;
  } catch (err: unknown) {
    if (err instanceof SyntaxError) {
      errors.push(`package.json at ${packageJsonPath} contains invalid JSON.`);
    } else {
      errors.push(`package.json not found at ${packageJsonPath} — run 'npm init' to create one.`);
    }
    return { success: false, errors, warnings };
  }

  // Check @opentelemetry/api in peerDependencies
  const peerDeps = packageJson.peerDependencies as Record<string, string> | undefined;
  const hasPeerOtel = peerDeps && typeof peerDeps === 'object' && '@opentelemetry/api' in peerDeps;

  if (!hasPeerOtel) {
    const regularDeps = packageJson.dependencies as Record<string, string> | undefined;
    const hasRegularOtel = regularDeps && typeof regularDeps === 'object' && '@opentelemetry/api' in regularDeps;

    if (hasRegularOtel) {
      errors.push(
        '@opentelemetry/api is in dependencies but must be in peerDependencies. ' +
        'Multiple instances in node_modules cause silent trace loss. ' +
        'Move it: npm install --save-peer @opentelemetry/api',
      );
    } else {
      errors.push(
        '@opentelemetry/api not found in peerDependencies. ' +
        'Add it: npm install --save-peer @opentelemetry/api',
      );
    }
    return { success: false, errors, warnings };
  }

  // Check Weaver CLI version
  deps.stderr('Checking Weaver CLI...');
  let weaverVersion: string;
  try {
    const versionOutput = deps.execFileSync('weaver', ['--version'], {
      timeout: 10000,
      stdio: 'pipe',
    });
    const versionString = versionOutput.toString().trim();
    const versionMatch = versionString.match(/(\d+\.\d+\.\d+)/);
    if (!versionMatch) {
      errors.push(`Could not parse Weaver version from output: ${versionString}`);
      return { success: false, errors, warnings };
    }
    weaverVersion = versionMatch[1];

    if (!isVersionSatisfied(weaverVersion, WEAVER_MIN_VERSION)) {
      errors.push(
        `Weaver CLI version ${weaverVersion} is below minimum ${WEAVER_MIN_VERSION}. ` +
        'Update Weaver: see https://github.com/open-telemetry/weaver',
      );
      return { success: false, errors, warnings };
    }
  } catch (err: unknown) {
    const error = err as { code?: string };
    if (error.code === 'ENOENT') {
      errors.push(
        'Weaver CLI not found. Install it: see https://github.com/open-telemetry/weaver',
      );
    } else {
      errors.push(`Failed to run Weaver CLI: ${err instanceof Error ? err.message : String(err)}`);
    }
    return { success: false, errors, warnings };
  }

  // Check port availability
  deps.stderr('Checking port availability...');
  for (const port of REQUIRED_PORTS) {
    const available = await deps.checkPort(port);
    if (!available) {
      errors.push(
        `Port ${port} is already in use. Weaver live-check requires ports 4317 (gRPC) and 4320 (HTTP). ` +
        'Free the port and try again.',
      );
    }
  }
  if (errors.length > 0) {
    return { success: false, errors, warnings };
  }

  // Detect SDK init file
  deps.stderr('Detecting SDK init file...');
  const foundInitFiles = deps.globSync(SDK_INIT_PATTERNS);
  if (foundInitFiles.length === 0) {
    errors.push(
      'SDK init file not found. Create an OTel SDK initialization file ' +
      '(e.g., src/instrumentation.ts) and re-run orb init.',
    );
    return { success: false, errors, warnings };
  }
  const sdkInitFile = foundInitFiles[0];

  // Detect schema directory
  deps.stderr('Detecting Weaver schema...');
  const schemaPath = deps.findSchemaDir(projectDir);
  if (!schemaPath) {
    errors.push(
      'Weaver schema directory not found. Create a schema directory ' +
      '(e.g., semconv/) with your semantic convention definitions and re-run orb init.',
    );
    return { success: false, errors, warnings };
  }

  // Validate Weaver schema
  deps.stderr('Validating Weaver schema...');
  try {
    deps.execFileSync('weaver', ['registry', 'check', '-r', join(projectDir, schemaPath)], {
      cwd: projectDir,
      timeout: 30000,
      stdio: 'pipe',
    });
  } catch (err: unknown) {
    const error = err as { stderr?: Buffer };
    const stderr = error.stderr ? error.stderr.toString().trim() : 'unknown error';
    errors.push(`Weaver schema validation failed at ${schemaPath}: ${stderr}`);
    return { success: false, errors, warnings };
  }

  // Detect project type
  const projectType = detectProjectType(packageJson);
  const dependencyStrategy = projectType === 'service' ? 'dependencies' : 'peerDependencies';

  deps.stderr(`Detected project type: ${projectType} (dependencyStrategy: ${dependencyStrategy})`);

  // Interactive confirmation
  if (!yes) {
    deps.stderr('');
    deps.stderr('Configuration summary:');
    deps.stderr(`  schemaPath: ${schemaPath}`);
    deps.stderr(`  sdkInitFile: ${sdkInitFile}`);
    deps.stderr(`  dependencyStrategy: ${dependencyStrategy}`);
    deps.stderr('');

    const answer = await deps.prompt('Create orb.yaml with these settings? [y/N] ');
    if (answer.toLowerCase() !== 'y') {
      errors.push('Init cancelled by user.');
      return { success: false, errors, warnings };
    }
  }

  // Write orb.yaml
  deps.stderr('Writing orb.yaml...');
  const config = {
    schemaPath,
    sdkInitFile,
    dependencyStrategy,
  };

  const yamlContent = stringifyYaml(config);
  await deps.writeFile(configPath, yamlContent);

  deps.stderr(`Created ${configPath}`);

  return {
    success: true,
    configPath,
    errors,
    warnings,
  };
}

export { handleInit, detectProjectType };
export type { InitOptions, InitDeps, InitResult };

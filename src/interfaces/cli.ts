#!/usr/bin/env node
// ABOUTME: CLI entry point for the orb command.
// ABOUTME: Defines init and instrument commands with yargs, wired to real handlers.

import { fileURLToPath } from 'node:url';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { resolve } from 'node:path';
import { handleInit } from './init-handler.ts';
import { createProductionDeps } from './init-deps.ts';
import { handleInstrument } from './instrument-handler.ts';
import { loadConfig } from '../config/loader.ts';
import { coordinate } from '../coordinator/coordinate.ts';
import { promptConfirm } from './prompt.ts';

/**
 * Build the yargs parser with all commands and options.
 * Exported separately from execution so tests can invoke the parser directly.
 */
export function buildParser() {
  return yargs()
    .scriptName('orb')
    .usage('$0 <command> [options]')
    .command(
      'init',
      'Initialize telemetry agent configuration',
      (y) => {
        return y.option('yes', {
          alias: 'y',
          type: 'boolean' as const,
          default: false,
          describe: 'Skip confirmation prompts',
        });
      },
    )
    .command(
      'instrument <path>',
      'Instrument JavaScript files with OpenTelemetry',
      (y) => {
        return y
          .positional('path', {
            type: 'string' as const,
            describe: 'Path to instrument',
            demandOption: true,
          })
          .option('dry-run', {
            type: 'boolean' as const,
            default: false,
            describe: 'Preview changes without writing',
          })
          .option('output', {
            choices: ['text', 'json'] as const,
            default: 'text' as const,
            describe: 'Output format',
          })
          .option('yes', {
            alias: 'y',
            type: 'boolean' as const,
            default: false,
            describe: 'Skip cost ceiling confirmation',
          })
          .option('verbose', {
            type: 'boolean' as const,
            default: false,
            describe: 'Show additional diagnostic output',
          })
          .option('debug', {
            type: 'boolean' as const,
            default: false,
            describe: 'Show debug-level diagnostic output',
          });
      },
    )
    .demandCommand(1, 'You must specify a command. Run orb --help for usage.')
    .strict()
    .help();
}

/**
 * Run the CLI. Called when the script is executed directly.
 * Init and instrument commands are wired to real handlers.
 */
export async function run(args?: string[]) {
  const parser = buildParser();
  const argv = await parser.parse(args ?? hideBin(process.argv));

  const command = argv._[0];

  if (command === 'init') {
    const projectDir = resolve(process.cwd());
    const yes = Boolean(argv.yes);
    const deps = createProductionDeps(projectDir);
    const result = await handleInit({ projectDir, yes }, deps);

    if (!result.success) {
      for (const error of result.errors) {
        console.error(error);
      }
      process.exit(1);
    }
    process.exit(0);
  } else if (command === 'instrument') {
    const targetPath = String(argv.path);
    const projectDir = resolve(process.cwd());
    const result = await handleInstrument(
      {
        path: targetPath,
        projectDir,
        dryRun: Boolean(argv.dryRun),
        output: (argv.output as 'text' | 'json') ?? 'text',
        yes: Boolean(argv.yes),
        verbose: Boolean(argv.verbose),
        debug: Boolean(argv.debug),
      },
      {
        loadConfig,
        coordinate,
        stderr: (msg: string) => console.error(msg),
        stdout: (msg: string) => console.log(msg),
        promptConfirm,
      },
    );
    process.exit(result.exitCode);
  }
}

// Run when executed directly (not imported)
const isDirectExecution = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectExecution) {
  run().catch((err) => {
    console.error('Unexpected error:', err);
    process.exit(1);
  });
}

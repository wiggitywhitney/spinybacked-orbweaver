#!/usr/bin/env node
// ABOUTME: CLI entry point for the orb command.
// ABOUTME: Defines init and instrument commands with yargs, wired to placeholder handlers.

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

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
 * Handlers are placeholders — wired to real implementations in later milestones.
 */
export async function run(args?: string[]) {
  const parser = buildParser();
  const argv = await parser.parse(args ?? hideBin(process.argv));

  const command = argv._[0];

  if (command === 'init') {
    console.error('orb init: not yet implemented');
    process.exit(1);
  } else if (command === 'instrument') {
    console.error('orb instrument: not yet implemented');
    process.exit(1);
  }
}

// Run when executed directly (not imported)
const isDirectExecution = process.argv[1] && import.meta.url.endsWith(process.argv[1]);
if (isDirectExecution) {
  run();
}

// ABOUTME: Unit tests for CLI argument parsing scaffold.
// ABOUTME: Verifies yargs commands, flags, defaults, and help output for init and instrument commands.

import { describe, it, expect } from 'vitest';
import { buildParser } from '../../src/interfaces/cli.ts';

/**
 * Parse CLI arguments using the exported parser builder.
 * Returns the parsed argv object.
 */
async function parse(args: string[]) {
  const parser = buildParser();
  return parser.parse(args);
}

describe('CLI scaffold', () => {
  describe('init command', () => {
    it('parses init with no flags', async () => {
      const argv = await parse(['init']);
      expect(argv._).toContain('init');
    });

    it('parses init with --yes flag', async () => {
      const argv = await parse(['init', '--yes']);
      expect(argv.yes).toBe(true);
    });

    it('parses init with -y alias', async () => {
      const argv = await parse(['init', '-y']);
      expect(argv.yes).toBe(true);
    });

    it('defaults --yes to false', async () => {
      const argv = await parse(['init']);
      expect(argv.yes).toBe(false);
    });
  });

  describe('instrument command', () => {
    it('parses instrument with required path', async () => {
      const argv = await parse(['instrument', './src']);
      expect(argv._).toContain('instrument');
      expect(argv.path).toBe('./src');
    });

    it('defaults all optional flags', async () => {
      const argv = await parse(['instrument', './src']);
      expect(argv.dryRun).toBe(false);
      expect(argv.output).toBe('text');
      expect(argv.yes).toBe(false);
      expect(argv.verbose).toBe(false);
      expect(argv.debug).toBe(false);
    });

    it('parses --dry-run flag', async () => {
      const argv = await parse(['instrument', './src', '--dry-run']);
      expect(argv.dryRun).toBe(true);
    });

    it('parses --output json', async () => {
      const argv = await parse(['instrument', './src', '--output', 'json']);
      expect(argv.output).toBe('json');
    });

    it('parses --output text', async () => {
      const argv = await parse(['instrument', './src', '--output', 'text']);
      expect(argv.output).toBe('text');
    });

    it('parses --yes flag', async () => {
      const argv = await parse(['instrument', './src', '--yes']);
      expect(argv.yes).toBe(true);
    });

    it('parses -y alias', async () => {
      const argv = await parse(['instrument', './src', '-y']);
      expect(argv.yes).toBe(true);
    });

    it('parses --verbose flag', async () => {
      const argv = await parse(['instrument', './src', '--verbose']);
      expect(argv.verbose).toBe(true);
    });

    it('parses --debug flag', async () => {
      const argv = await parse(['instrument', './src', '--debug']);
      expect(argv.debug).toBe(true);
    });

    it('parses multiple flags together', async () => {
      const argv = await parse([
        'instrument', './src',
        '--dry-run', '--output', 'json', '--yes', '--verbose', '--debug',
      ]);
      expect(argv.dryRun).toBe(true);
      expect(argv.output).toBe('json');
      expect(argv.yes).toBe(true);
      expect(argv.verbose).toBe(true);
      expect(argv.debug).toBe(true);
    });
  });

  describe('help output', () => {
    it('includes init command in help', async () => {
      const parser = buildParser();
      const help = await parser.getHelp();
      expect(help).toContain('init');
      expect(help).toContain('Initialize');
    });

    it('includes instrument command in help', async () => {
      const parser = buildParser();
      const help = await parser.getHelp();
      expect(help).toContain('instrument');
      expect(help).toContain('Instrument');
    });
  });
});

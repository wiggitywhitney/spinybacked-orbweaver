// ABOUTME: Tests that CLI and MCP entry points auto-load .env files.
// ABOUTME: Verifies process.loadEnvFile is called and errors are silently caught.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock all heavy dependencies so run() and startServer() don't do real work.
vi.mock('../../src/interfaces/init-handler.ts', () => ({
  handleInit: vi.fn().mockResolvedValue({ success: true, errors: [] }),
}));
vi.mock('../../src/interfaces/init-deps.ts', () => ({
  createProductionDeps: vi.fn().mockReturnValue({}),
}));
vi.mock('../../src/interfaces/instrument-handler.ts', () => ({
  handleInstrument: vi.fn().mockResolvedValue({ exitCode: 0 }),
}));
vi.mock('../../src/config/loader.ts', () => ({
  loadConfig: vi.fn(),
}));
vi.mock('../../src/coordinator/coordinate.ts', () => ({
  coordinate: vi.fn(),
}));
vi.mock('../../src/interfaces/prompt.ts', () => ({
  promptConfirm: vi.fn(),
}));
vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => {
  const McpServer = class {
    registerTool = vi.fn();
    connect = vi.fn().mockResolvedValue(undefined);
    constructor() {}
  };
  return { McpServer };
});
vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => {
  const StdioServerTransport = class {};
  return { StdioServerTransport };
});

// Stub process.exit so run() doesn't kill the test runner.
const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

describe('.env auto-loading', () => {
  let loadEnvFileSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    loadEnvFileSpy = vi.spyOn(process, 'loadEnvFile').mockImplementation(() => undefined);
    exitSpy.mockClear();
  });

  afterEach(() => {
    loadEnvFileSpy.mockRestore();
  });

  describe('CLI run()', () => {
    it('calls process.loadEnvFile with .env', async () => {
      const { run } = await import('../../src/interfaces/cli.ts');
      await run(['init']);
      expect(loadEnvFileSpy).toHaveBeenCalledWith('.env');
    });

    it('does not throw when .env file is missing', async () => {
      const err = new Error('ENOENT: no such file or directory') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      loadEnvFileSpy.mockImplementation(() => { throw err; });
      const { run } = await import('../../src/interfaces/cli.ts');
      await expect(run(['init'])).resolves.toBeUndefined();
    });

    it('rethrows non-ENOENT errors from loadEnvFile', async () => {
      const err = new Error('Permission denied') as NodeJS.ErrnoException;
      err.code = 'EACCES';
      loadEnvFileSpy.mockImplementation(() => { throw err; });
      const { run } = await import('../../src/interfaces/cli.ts');
      await expect(run(['init'])).rejects.toThrow('Permission denied');
    });
  });

  describe('MCP startServer()', () => {
    it('calls process.loadEnvFile with .env', async () => {
      const { startServer } = await import('../../src/interfaces/mcp.ts');
      await startServer();
      expect(loadEnvFileSpy).toHaveBeenCalledWith('.env');
    });

    it('does not throw when .env file is missing', async () => {
      const err = new Error('ENOENT: no such file or directory') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      loadEnvFileSpy.mockImplementation(() => { throw err; });
      const { startServer } = await import('../../src/interfaces/mcp.ts');
      await expect(startServer()).resolves.toBeUndefined();
    });

    it('rethrows non-ENOENT errors from loadEnvFile', async () => {
      const err = new Error('Permission denied') as NodeJS.ErrnoException;
      err.code = 'EACCES';
      loadEnvFileSpy.mockImplementation(() => { throw err; });
      const { startServer } = await import('../../src/interfaces/mcp.ts');
      await expect(startServer()).rejects.toThrow('Permission denied');
    });
  });
});

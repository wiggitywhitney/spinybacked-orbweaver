#!/usr/bin/env node
// ABOUTME: Thin JS wrapper for the orb CLI entry point.
// ABOUTME: Needed because Node.js refuses to type-strip .ts files under node_modules.

import { run } from '../src/interfaces/cli.ts';

run().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});

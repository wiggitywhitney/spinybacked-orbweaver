#!/usr/bin/env node
// ABOUTME: Thin JS wrapper for the spiny-orb CLI entry point.
// ABOUTME: Needed because Node.js refuses to type-strip .ts files under node_modules.

import { run } from '../dist/interfaces/cli.js';

const [major] = process.versions.node.split('.').map(Number);
if (major < 24) {
  console.error(`spiny-orb requires Node.js >= 24. You are running ${process.version}.`);
  process.exit(1);
}

run().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});

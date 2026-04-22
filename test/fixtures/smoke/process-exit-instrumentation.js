// ABOUTME: Smoke test fixture — mirrors the index.js process.exit() failure pattern.
// ABOUTME: main() calls process.exit() directly; gatherData/saveResult are proper span candidates.

const { readFile, writeFile } = require('node:fs/promises');
const { join } = require('node:path');

const DATA_DIR = process.env.DATA_DIR ?? './data';
const OUTPUT_DIR = process.env.OUTPUT_DIR ?? './output';

/**
 * Fetch raw entries from disk. Async I/O — proper span candidate.
 */
async function gatherData(sourceDir) {
  const indexPath = join(sourceDir, 'index.json');
  const raw = await readFile(indexPath, 'utf-8');
  const index = JSON.parse(raw);

  const entries = [];
  for (const id of index.ids) {
    const entryPath = join(sourceDir, `${id}.json`);
    const content = await readFile(entryPath, 'utf-8');
    entries.push(JSON.parse(content));
  }

  return entries;
}

/**
 * Persist processed results to disk. Async I/O — proper span candidate.
 */
async function saveResult(outputDir, results) {
  const outPath = join(outputDir, 'results.json');
  const payload = {
    generatedAt: new Date().toISOString(),
    count: results.length,
    results,
  };
  await writeFile(outPath, JSON.stringify(payload, null, 2), 'utf-8');
  return outPath;
}

/**
 * Transform raw entries into output records. Pure sync — not a span candidate.
 */
function processEntries(entries) {
  return entries.map((entry) => ({
    id: entry.id,
    summary: entry.title.trim().toLowerCase(),
    score: entry.score ?? 0,
  }));
}

/**
 * CLI entry point. Calls process.exit() directly on bad arguments —
 * this function cannot be safely spanned because process.exit() bypasses
 * the span's finally block. The async sub-operations (gatherData, saveResult)
 * are the correct instrumentation targets.
 */
async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: node process-exit-instrumentation.js [--dry-run]');
    process.exit(0);
  }

  if (!process.env.DATA_DIR && !process.env.OUTPUT_DIR) {
    console.error('Warning: DATA_DIR and OUTPUT_DIR not set, using defaults.');
  }

  const dryRun = args.includes('--dry-run');

  try {
    const entries = await gatherData(DATA_DIR);
    const processed = processEntries(entries);

    if (dryRun) {
      console.log(`Dry run: would write ${processed.length} results`);
      return;
    }

    const outPath = await saveResult(OUTPUT_DIR, processed);
    console.log(`Wrote ${processed.length} results to ${outPath}`);
  } catch (err) {
    console.error('Fatal error:', err.message);
    process.exit(1);
  }
}

main();

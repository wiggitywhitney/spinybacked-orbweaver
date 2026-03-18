#!/usr/bin/env node
// ABOUTME: Test fixture — CLI entry point; main() and handleSummarize() are the primary instrumentation targets.
// ABOUTME: Run-5 FAILED: SCH-002 oscillation (9 to 12 violations) on commit_story.summarize.* attrs (schema gap); run-4: 2 spans.
/**
 * Commit Story - Automated Engineering Journal
 *
 * Generates journal entries from git commits and Claude Code chat history.
 * Triggered by git post-commit hook or run manually.
 *
 * Usage:
 *   npx commit-story [commitRef] [--debug]
 *   node src/index.js [commitRef] [--debug]
 *
 * Exit codes:
 *   0 - Success (journal generated)
 *   1 - Error occurred
 *   2 - Skipped (journal-only commit, empty merge)
 */

import './utils/config.js'; // Load environment variables first
import { config } from './utils/config.js';
import { execFileSync } from 'node:child_process';
import { gatherContextForCommit } from './integrators/context-integrator.js';
import { generateJournalSections } from './generators/journal-graph.js';
import { saveJournalEntry, discoverReflections } from './managers/journal-manager.js';
import { isJournalEntriesOnlyCommit, isMergeCommit, shouldSkipMergeCommit, isSafeGitRef } from './utils/commit-analyzer.js';
import { triggerAutoSummaries } from './managers/auto-summarize.js';
import { parseSummarizeArgs, runSummarize, runWeeklySummarize, runMonthlySummarize, showSummarizeHelp } from './commands/summarize.js';

/** Exit codes */
const EXIT_SUCCESS = 0;
const EXIT_ERROR = 1;
const EXIT_SKIPPED = 2;

/** Debug mode flag */
let DEBUG = false;

/**
 * Log debug message if debug mode is enabled
 * @param {...any} args - Arguments to log
 */
function debug(...args) {
  if (DEBUG) {
    console.log('[DEBUG]', ...args);
  }
}

/**
 * Parse command line arguments
 * @returns {{ subcommand: string|null, commitRef: string, debug: boolean, help: boolean, subcommandArgs: string[] }}
 */
function parseArgs() {
  const args = process.argv.slice(2);

  let commitRef = 'HEAD';
  let showHelp = false;
  let subcommand = null;
  const subcommandArgs = [];

  // Check if first non-flag argument is a known subcommand
  const knownSubcommands = ['summarize'];
  const firstNonFlag = args.find(a => !a.startsWith('-'));
  if (firstNonFlag && knownSubcommands.includes(firstNonFlag)) {
    subcommand = firstNonFlag;
    // Everything after the subcommand name goes to the subcommand handler
    const subIdx = args.indexOf(firstNonFlag);
    subcommandArgs.push(
      ...args
        .slice(subIdx + 1)
        .filter(arg => arg !== '--debug' && arg !== '-d')
    );
    // Still check for global --debug flag
    for (const arg of args) {
      if (arg === '--debug' || arg === '-d') {
        DEBUG = true;
      }
    }
    return { subcommand, commitRef, debug: DEBUG, help: false, subcommandArgs };
  }

  for (const arg of args) {
    if (arg === '--debug' || arg === '-d') {
      DEBUG = true;
    } else if (arg === '--help' || arg === '-h') {
      showHelp = true;
    } else if (!arg.startsWith('-')) {
      commitRef = arg;
    }
  }

  return { subcommand, commitRef, debug: DEBUG, help: showHelp, subcommandArgs };
}

/**
 * Show help message
 */
function showHelp() {
  console.log(`
Commit Story - Automated Engineering Journal

Usage:
  npx commit-story [commitRef] [options]
  npx commit-story summarize <date|range> [--force]

Commands:
  summarize    Generate daily, weekly, or monthly summaries
               Use --help for subcommand details

Arguments:
  commitRef    Git commit reference (default: HEAD)
               Examples: HEAD, abc1234, HEAD~3

Options:
  --debug, -d  Enable debug output
  --help, -h   Show this help message

Examples:
  npx commit-story                              # Generate for latest commit
  npx commit-story HEAD~1                       # Generate for previous commit
  npx commit-story summarize 2026-02-22         # Summarize a day
  npx commit-story summarize 2026-02-01..2026-02-20  # Summarize a range
  npx commit-story --debug                      # Verbose output

Exit codes:
  0  Success (journal entry generated)
  1  Error occurred
  2  Skipped (journal-only commit or empty merge)
`);
}

/**
 * Check if running inside a git repository
 * @returns {boolean}
 */
function isGitRepository() {
  try {
    execFileSync('git', ['rev-parse', '--git-dir'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate that a commit reference exists
 * @param {string} ref - Commit reference to validate
 * @returns {boolean}
 */
function isValidCommitRef(ref) {
  if (!isSafeGitRef(ref)) {
    return false;
  }
  try {
    execFileSync('git', ['rev-parse', '--verify', ref], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate environment requirements
 * @returns {boolean}
 */
function validateEnvironment() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(`
❌ ANTHROPIC_API_KEY not set
   Set your API key: export ANTHROPIC_API_KEY=your-key
`);
    return false;
  }
  return true;
}

/**
 * Get previous commit timestamp for reflection discovery
 * @param {string} commitRef - Current commit reference
 * @returns {Date|null}
 */
function getPreviousCommitTime(commitRef) {
  if (!isSafeGitRef(commitRef)) {
    const fallback = new Date();
    fallback.setHours(fallback.getHours() - 24);
    return fallback;
  }
  try {
    // Get the commit before the current one
    const output = execFileSync('git', ['log', '-1', '--format=%cI', `${commitRef}~1`], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    return new Date(output.trim());
  } catch {
    // No previous commit (first commit) or error
    // Use 24 hours ago as fallback
    const fallback = new Date();
    fallback.setHours(fallback.getHours() - 24);
    return fallback;
  }
}

/**
 * Handle the "summarize" subcommand.
 * @param {string[]} args - Arguments after "summarize"
 */
async function handleSummarize(args) {
  const parsed = parseSummarizeArgs(args);

  if (parsed.help) {
    showSummarizeHelp();
    process.exit(EXIT_SUCCESS);
  }

  if (parsed.error) {
    console.error(`\n❌ ${parsed.error}\n`);
    process.exit(EXIT_ERROR);
  }

  // Validate environment (need API key for generation)
  if (!validateEnvironment()) {
    process.exit(EXIT_ERROR);
  }

  // Weekly mode
  if (parsed.weekly) {
    const total = parsed.weeks.length;
    console.log(`\n📊 Generating weekly summaries for ${total} week${total > 1 ? 's' : ''}...`);
    if (parsed.force) {
      console.log('   --force: regenerating existing summaries');
    }

    let completed = 0;
    const result = await runWeeklySummarize({
      weeks: parsed.weeks,
      force: parsed.force,
      basePath: '.',
      onProgress: (msg) => {
        completed++;
        console.log(`   [${completed}/${total}] ${msg}`);
      },
    });

    console.log('');
    if (result.generated.length > 0) {
      console.log(`✅ Generated: ${result.generated.length} weekly summary(ies)`);
    }
    if (result.noSummaries.length > 0) {
      console.log(`⏭️  No daily summaries: ${result.noSummaries.length} week(s)`);
    }
    if (result.alreadyExists.length > 0) {
      console.log(`⏭️  Already exist: ${result.alreadyExists.length} week(s)`);
    }
    if (result.failed.length > 0) {
      console.log(`❌ Failed: ${result.failed.length} week(s)`);
      for (const weekStr of result.failed) {
        console.log(`   - ${weekStr}`);
      }
    }
    if (result.errors.length > 0) {
      console.log('');
      console.log('⚠️  Errors:');
      for (const err of result.errors) {
        console.log(`   - ${err}`);
      }
    }
    console.log('');

    process.exit(result.failed.length > 0 ? EXIT_ERROR : EXIT_SUCCESS);
    return;
  }

  // Monthly mode
  if (parsed.monthly) {
    const total = parsed.months.length;
    console.log(`\n📊 Generating monthly summaries for ${total} month${total > 1 ? 's' : ''}...`);
    if (parsed.force) {
      console.log('   --force: regenerating existing summaries');
    }

    let completed = 0;
    const result = await runMonthlySummarize({
      months: parsed.months,
      force: parsed.force,
      basePath: '.',
      onProgress: (msg) => {
        completed++;
        console.log(`   [${completed}/${total}] ${msg}`);
      },
    });

    console.log('');
    if (result.generated.length > 0) {
      console.log(`✅ Generated: ${result.generated.length} monthly summary(ies)`);
    }
    if (result.noSummaries.length > 0) {
      console.log(`⏭️  No weekly summaries: ${result.noSummaries.length} month(s)`);
    }
    if (result.alreadyExists.length > 0) {
      console.log(`⏭️  Already exist: ${result.alreadyExists.length} month(s)`);
    }
    if (result.failed.length > 0) {
      console.log(`❌ Failed: ${result.failed.length} month(s)`);
      for (const monthStr of result.failed) {
        console.log(`   - ${monthStr}`);
      }
    }
    if (result.errors.length > 0) {
      console.log('');
      console.log('⚠️  Errors:');
      for (const err of result.errors) {
        console.log(`   - ${err}`);
      }
    }
    console.log('');

    process.exit(result.failed.length > 0 ? EXIT_ERROR : EXIT_SUCCESS);
    return;
  }

  // Daily mode
  const total = parsed.dates.length;
  console.log(`\n📊 Generating daily summaries for ${total} date${total > 1 ? 's' : ''}...`);
  if (parsed.force) {
    console.log('   --force: regenerating existing summaries');
  }

  let completed = 0;
  const result = await runSummarize({
    dates: parsed.dates,
    force: parsed.force,
    basePath: '.',
    onProgress: (msg) => {
      completed++;
      console.log(`   [${completed}/${total}] ${msg}`);
    },
  });

  // Print summary
  console.log('');
  if (result.generated.length > 0) {
    console.log(`✅ Generated: ${result.generated.length} summary(ies)`);
  }
  if (result.noEntries.length > 0) {
    console.log(`⏭️  No entries: ${result.noEntries.length} date(s)`);
  }
  if (result.alreadyExists.length > 0) {
    console.log(`⏭️  Already exist: ${result.alreadyExists.length} date(s)`);
  }
  if (result.failed.length > 0) {
    console.log(`❌ Failed: ${result.failed.length} date(s)`);
    for (const dateStr of result.failed) {
      console.log(`   - ${dateStr}`);
    }
  }
  if (result.errors.length > 0) {
    console.log('');
    console.log('⚠️  Errors:');
    for (const err of result.errors) {
      console.log(`   - ${err}`);
    }
  }
  console.log('');

  process.exit(result.failed.length > 0 ? EXIT_ERROR : EXIT_SUCCESS);
}

/**
 * Main entry point
 */
async function main() {
  const { subcommand, commitRef, help, subcommandArgs } = parseArgs();

  // Show help if requested
  if (help) {
    showHelp();
    process.exit(EXIT_SUCCESS);
  }

  // Route to subcommand handlers
  if (subcommand === 'summarize') {
    await handleSummarize(subcommandArgs);
    return;
  }

  debug('Starting commit-story');
  debug('Commit ref:', commitRef);

  // Validate git repository
  if (!isGitRepository()) {
    console.error(`
❌ Not a git repository
   Run commit-story from within a git repository.
`);
    process.exit(EXIT_ERROR);
  }

  // Validate commit reference
  if (!isValidCommitRef(commitRef)) {
    console.error(`
❌ Invalid commit reference: ${commitRef}
   Check that the commit exists: git log --oneline
`);
    process.exit(EXIT_ERROR);
  }

  // Validate environment
  if (!validateEnvironment()) {
    process.exit(EXIT_ERROR);
  }

  // Check skip conditions BEFORE expensive context collection
  debug('Checking skip conditions...');

  // Skip journal-entries-only commits
  if (isJournalEntriesOnlyCommit(commitRef)) {
    console.log(`
⏭️  Skipping: only journal entries changed
   This commit only modified journal/entries/ files.
`);
    process.exit(EXIT_SKIPPED);
  }

  // Check for merge commits
  const mergeInfo = isMergeCommit(commitRef);
  debug('Merge commit:', mergeInfo.isMerge);

  // Gather context
  debug('Gathering context...');
  const context = await gatherContextForCommit(commitRef);
  debug('Context gathered:', {
    messageCount: context.chat?.messageCount || 0,
    diffLength: context.commit?.diff?.length || 0,
  });

  // Skip empty merge commits (no chat AND no diff)
  if (mergeInfo.isMerge) {
    const hasChat = context.chat && context.chat.messageCount > 0;
    const hasDiff = context.commit && context.commit.diff && context.commit.diff.trim().length > 0;

    if (!hasChat && !hasDiff) {
      console.log(`
⏭️  Skipping: merge commit with no changes
   This merge commit has no chat context or code changes.
`);
      process.exit(EXIT_SKIPPED);
    }
    debug('Processing merge commit with:', { hasChat, hasDiff });
  }

  // Generate journal sections
  debug('Generating journal sections...');
  const sections = await generateJournalSections(context);
  debug('Sections generated:', {
    hasSummary: !!sections.summary,
    hasDialogue: !!sections.dialogue,
    hasTechnical: !!sections.technicalDecisions,
    errors: sections.errors?.length || 0,
  });

  // Discover reflections for time window
  const previousCommitTime = getPreviousCommitTime(commitRef);
  const currentCommitTime = context.commit.timestamp;
  debug('Reflection window:', { from: previousCommitTime, to: currentCommitTime });

  const reflections = await discoverReflections(previousCommitTime, currentCommitTime);
  debug('Reflections found:', reflections.length);

  // Save journal entry
  debug('Saving journal entry...');
  const savedPath = await saveJournalEntry(sections, context.commit, reflections, '.', { debug });

  console.log(`
✅ Journal entry saved
   ${savedPath}
`);

  // Log any generation errors
  if (sections.errors && sections.errors.length > 0) {
    console.log('⚠️  Some sections had generation issues:');
    for (const err of sections.errors) {
      console.log(`   - ${err}`);
    }
  }

  // Auto-generate daily and weekly summaries for unsummarized past days/weeks
  if (config.autoSummarize) {
    debug('Checking for unsummarized days and weeks...');
    try {
      const summaryResult = await triggerAutoSummaries('.', {
        onProgress: (msg) => debug(msg),
      });

      if (summaryResult.generated.length > 0) {
        const dailyCount = summaryResult.generated.filter(p => p.includes('daily')).length;
        const weeklyCount = summaryResult.generated.filter(p => p.includes('weekly')).length;
        const monthlyCount = summaryResult.generated.filter(p => p.includes('monthly')).length;
        const parts = [];
        if (dailyCount > 0) parts.push(`${dailyCount} daily`);
        if (weeklyCount > 0) parts.push(`${weeklyCount} weekly`);
        if (monthlyCount > 0) parts.push(`${monthlyCount} monthly`);
        console.log(`📊 Generated ${parts.join(' + ')} summary(ies)`);
        for (const path of summaryResult.generated) {
          debug(`   ${path}`);
        }
      }

      if (summaryResult.failed.length > 0) {
        console.log(`⚠️  Failed to generate ${summaryResult.failed.length} summary(ies)`);
        for (const dateStr of summaryResult.failed) {
          console.log(`   - ${dateStr}`);
        }
      }
    } catch (err) {
      // Auto-summarize failures should not block the main flow
      console.log(`⚠️  Auto-summarize error: ${err.message}`);
      debug(err.stack);
    }
  }

  process.exit(EXIT_SUCCESS);
}

// Run main function
main().catch((error) => {
  console.error(`
❌ Unexpected error: ${error.message}
`);
  if (DEBUG) {
    console.error(error.stack);
  }
  process.exit(EXIT_ERROR);
});

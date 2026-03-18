// ABOUTME: Test fixture — CLI handler for daily/weekly/monthly summary backfill; 3 exported async entry points.
// ABOUTME: Run-5 FAILED: SCH-002 on commit_story.summarize.* attrs (schema gap) + COV-003 on 4 expected-condition catches; run-4: 3 spans.

import { generateAndSaveDailySummary, generateAndSaveWeeklySummary, generateAndSaveMonthlySummary } from '../managers/summary-manager.js';
import { readDayEntries } from '../managers/summary-manager.js';
import { getSummaryPath } from '../utils/journal-paths.js';
import { access } from 'node:fs/promises';

/**
 * Validate a YYYY-MM-DD date string.
 * @param {string} str - Date string to validate
 * @returns {boolean} True if valid date format
 */
function isValidDate(str) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) return false;
  const [year, month, day] = str.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  return (
    date.getFullYear() === year &&
    date.getMonth() === month - 1 &&
    date.getDate() === day
  );
}

/**
 * Validate an ISO week string (YYYY-Www).
 * @param {string} str - Week string to validate
 * @returns {boolean} True if valid format
 */
export function isValidWeekString(str) {
  if (!/^\d{4}-W\d{2}$/.test(str)) return false;
  const year = parseInt(str.slice(0, 4));
  const week = parseInt(str.slice(6));
  if (week < 1 || week > 53) return false;
  if (week === 53) {
    // ISO week 53 exists only if Jan 1 is Thursday,
    // or if Jan 1 is Wednesday in a leap year
    const jan1 = new Date(year, 0, 1);
    const jan1Day = jan1.getDay(); // 0=Sun, 4=Thu
    const isLeap = (year % 4 === 0 && year % 100 !== 0) || (year % 400 === 0);
    if (jan1Day !== 4 && !(jan1Day === 3 && isLeap)) return false;
  }
  return true;
}

/**
 * Validate a month string (YYYY-MM).
 * @param {string} str - Month string to validate
 * @returns {boolean} True if valid format
 */
export function isValidMonthString(str) {
  if (!/^\d{4}-\d{2}$/.test(str)) return false;
  const month = parseInt(str.slice(5));
  return month >= 1 && month <= 12;
}

/**
 * Expand a date range (inclusive) into an array of YYYY-MM-DD strings.
 * @param {string} startStr - Start date (YYYY-MM-DD)
 * @param {string} endStr - End date (YYYY-MM-DD)
 * @returns {string[]} Array of date strings
 */
export function expandDateRange(startStr, endStr) {
  const dates = [];
  const [sy, sm, sd] = startStr.split('-').map(Number);
  const [ey, em, ed] = endStr.split('-').map(Number);
  const start = new Date(sy, sm - 1, sd);
  const end = new Date(ey, em - 1, ed);

  const current = new Date(start);
  while (current <= end) {
    const y = current.getFullYear();
    const m = String(current.getMonth() + 1).padStart(2, '0');
    const d = String(current.getDate()).padStart(2, '0');
    dates.push(`${y}-${m}-${d}`);
    current.setDate(current.getDate() + 1);
  }

  return dates;
}

/**
 * Parse arguments for the summarize subcommand.
 * @param {string[]} args - Arguments after "summarize"
 * @returns {{ dates: string[], weeks: string[], months: string[], force: boolean, help: boolean, weekly: boolean, monthly: boolean, error: string|null }}
 */
export function parseSummarizeArgs(args) {
  let force = false;
  let help = false;
  let weekly = false;
  let monthly = false;
  const positionalArgs = [];
  const unknownFlags = [];

  for (const arg of args) {
    if (arg === '--force') {
      force = true;
    } else if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg === '--weekly') {
      weekly = true;
    } else if (arg === '--monthly') {
      monthly = true;
    } else if (!arg.startsWith('-')) {
      positionalArgs.push(arg);
    } else {
      unknownFlags.push(arg);
    }
  }

  if (weekly && monthly) {
    return { dates: [], weeks: [], months: [], force, help: false, weekly, monthly, error: 'Use either --weekly or --monthly, not both.' };
  }
  if (unknownFlags.length > 0) {
    return { dates: [], weeks: [], months: [], force, help: false, weekly, monthly, error: `Unknown option(s): ${unknownFlags.join(', ')}` };
  }
  if (positionalArgs.length > 1) {
    return { dates: [], weeks: [], months: [], force, help: false, weekly, monthly, error: `Too many arguments: ${positionalArgs.join(' ')}` };
  }
  const dateArg = positionalArgs[0] || null;

  if (help) {
    return { dates: [], weeks: [], months: [], force, help: true, weekly, monthly, error: null };
  }

  if (!dateArg) {
    let usage;
    if (monthly) {
      usage = 'Missing month argument. Usage: commit-story summarize --monthly <YYYY-MM> [--force]';
    } else if (weekly) {
      usage = 'Missing week argument. Usage: commit-story summarize --weekly <YYYY-Www> [--force]';
    } else {
      usage = 'Missing date argument. Usage: commit-story summarize <date|date-range> [--force]';
    }
    return { dates: [], weeks: [], months: [], force, help: false, weekly, monthly, error: usage };
  }

  // Monthly mode: expect YYYY-MM string
  if (monthly) {
    if (!isValidMonthString(dateArg)) {
      return { dates: [], weeks: [], months: [], force, help: false, weekly, monthly, error: `Invalid month format: ${dateArg}. Expected YYYY-MM (e.g., 2026-02)` };
    }
    return { dates: [], weeks: [], months: [dateArg], force, help: false, weekly, monthly, error: null };
  }

  // Weekly mode: expect ISO week string(s)
  if (weekly) {
    if (!isValidWeekString(dateArg)) {
      return { dates: [], weeks: [], months: [], force, help: false, weekly, monthly, error: `Invalid week format: ${dateArg}. Expected YYYY-Www (e.g., 2026-W08)` };
    }
    return { dates: [], weeks: [dateArg], months: [], force, help: false, weekly, monthly, error: null };
  }

  // Daily mode: date or date range
  // Check for range (date..date)
  if (dateArg.includes('..')) {
    const parts = dateArg.split('..');
    if (parts.length !== 2) {
      return { dates: [], weeks: [], months: [], force, help: false, weekly, monthly, error: `Invalid date range: ${dateArg}` };
    }
    const [a, b] = parts;
    if (!isValidDate(a) || !isValidDate(b)) {
      return { dates: [], weeks: [], months: [], force, help: false, weekly, monthly, error: `Invalid date in range: ${dateArg}` };
    }
    // Normalize reversed ranges to ascending
    const start = a <= b ? a : b;
    const end = a <= b ? b : a;
    const dates = expandDateRange(start, end);
    return { dates, weeks: [], months: [], force, help: false, weekly, monthly, error: null };
  }

  // Single date
  if (!isValidDate(dateArg)) {
    return { dates: [], weeks: [], months: [], force, help: false, weekly, monthly, error: `Invalid date format: ${dateArg}. Expected YYYY-MM-DD` };
  }

  return { dates: [dateArg], weeks: [], months: [], force, help: false, weekly, monthly, error: null };
}

/**
 * Run the summarize command — generate daily summaries for the given dates.
 * @param {{ dates: string[], force: boolean, basePath?: string, onProgress?: (msg: string) => void }} options
 * @returns {Promise<{ generated: string[], noEntries: string[], alreadyExists: string[], failed: string[], errors: string[] }>}
 */
export async function runSummarize(options) {
  const { dates, force, basePath = '.', onProgress } = options;

  const result = {
    generated: [],
    noEntries: [],
    alreadyExists: [],
    failed: [],
    errors: [],
  };

  for (const dateStr of dates) {
    const [year, month, day] = dateStr.split('-').map(Number);
    const date = new Date(year, month - 1, day);

    try {
      // Check for entries first
      const entries = await readDayEntries(date, basePath);
      if (entries.length === 0) {
        result.noEntries.push(dateStr);
        if (onProgress) {
          onProgress(`Skipped ${dateStr}: no entries`);
        }
        continue;
      }

      // Check for existing summary (unless --force)
      if (!force) {
        const summaryPath = getSummaryPath('daily', date, basePath);
        try {
          await access(summaryPath);
          result.alreadyExists.push(dateStr);
          if (onProgress) {
            onProgress(`Skipped ${dateStr}: summary already exists`);
          }
          continue;
        } catch {
          // Doesn't exist, proceed
        }
      }

      // Generate and save
      const genResult = await generateAndSaveDailySummary(date, basePath, { force });

      if (genResult.saved) {
        result.generated.push(dateStr);
        if (onProgress) {
          onProgress(`Generated summary for ${dateStr} (${genResult.entryCount} entries)`);
        }
        if (genResult.errors && genResult.errors.length > 0) {
          for (const err of genResult.errors) {
            result.errors.push(`${dateStr}: ${err}`);
          }
        }
      } else {
        // Shouldn't happen since we checked above, but handle gracefully
        result.noEntries.push(dateStr);
      }
    } catch (err) {
      result.failed.push(dateStr);
      result.errors.push(`${dateStr}: ${err.message}`);
      if (onProgress) {
        onProgress(`Failed ${dateStr}: ${err.message}`);
      }
    }
  }

  return result;
}

/**
 * Run the weekly summarize command — generate weekly summaries for the given weeks.
 * @param {{ weeks: string[], force: boolean, basePath?: string, onProgress?: (msg: string) => void }} options
 * @returns {Promise<{ generated: string[], noSummaries: string[], alreadyExists: string[], failed: string[], errors: string[] }>}
 */
export async function runWeeklySummarize(options) {
  const { weeks, force, basePath = '.', onProgress } = options;

  const result = {
    generated: [],
    noSummaries: [],
    alreadyExists: [],
    failed: [],
    errors: [],
  };

  for (const weekStr of weeks) {
    try {
      const genResult = await generateAndSaveWeeklySummary(weekStr, basePath, { force });

      if (genResult.saved) {
        result.generated.push(weekStr);
        if (onProgress) {
          onProgress(`Generated weekly summary for ${weekStr} (${genResult.dayCount} daily summaries)`);
        }
        if (genResult.errors && genResult.errors.length > 0) {
          for (const err of genResult.errors) {
            result.errors.push(`${weekStr}: ${err}`);
          }
        }
      } else if (genResult.reason && genResult.reason.includes('no daily summaries')) {
        result.noSummaries.push(weekStr);
        if (onProgress) {
          onProgress(`Skipped ${weekStr}: no daily summaries`);
        }
      } else if (genResult.reason && genResult.reason.includes('already exists')) {
        result.alreadyExists.push(weekStr);
        if (onProgress) {
          onProgress(`Skipped ${weekStr}: weekly summary already exists`);
        }
      } else {
        result.noSummaries.push(weekStr);
      }
    } catch (err) {
      result.failed.push(weekStr);
      result.errors.push(`${weekStr}: ${err.message}`);
      if (onProgress) {
        onProgress(`Failed ${weekStr}: ${err.message}`);
      }
    }
  }

  return result;
}

/**
 * Run the monthly summarize command — generate monthly summaries for the given months.
 * @param {{ months: string[], force: boolean, basePath?: string, onProgress?: (msg: string) => void }} options
 * @returns {Promise<{ generated: string[], noSummaries: string[], alreadyExists: string[], failed: string[], errors: string[] }>}
 */
export async function runMonthlySummarize(options) {
  const { months, force, basePath = '.', onProgress } = options;

  const result = {
    generated: [],
    noSummaries: [],
    alreadyExists: [],
    failed: [],
    errors: [],
  };

  for (const monthStr of months) {
    try {
      const genResult = await generateAndSaveMonthlySummary(monthStr, basePath, { force });

      if (genResult.saved) {
        result.generated.push(monthStr);
        if (onProgress) {
          onProgress(`Generated monthly summary for ${monthStr} (${genResult.weekCount} weekly summaries)`);
        }
        if (genResult.errors && genResult.errors.length > 0) {
          for (const err of genResult.errors) {
            result.errors.push(`${monthStr}: ${err}`);
          }
        }
      } else if (genResult.reason && genResult.reason.includes('no weekly summaries')) {
        result.noSummaries.push(monthStr);
        if (onProgress) {
          onProgress(`Skipped ${monthStr}: no weekly summaries`);
        }
      } else if (genResult.reason && genResult.reason.includes('already exists')) {
        result.alreadyExists.push(monthStr);
        if (onProgress) {
          onProgress(`Skipped ${monthStr}: monthly summary already exists`);
        }
      } else {
        result.noSummaries.push(monthStr);
      }
    } catch (err) {
      result.failed.push(monthStr);
      result.errors.push(`${monthStr}: ${err.message}`);
      if (onProgress) {
        onProgress(`Failed ${monthStr}: ${err.message}`);
      }
    }
  }

  return result;
}

/**
 * Show help text for the summarize subcommand.
 */
export function showSummarizeHelp() {
  const helpText = `
Commit Story — Summarize

Generate daily, weekly, or monthly summaries for journal entries.

Usage:
  npx commit-story summarize <date> [--force]
  npx commit-story summarize <start>..<end> [--force]
  npx commit-story summarize --weekly <YYYY-Www> [--force]
  npx commit-story summarize --monthly <YYYY-MM> [--force]

Arguments:
  date         Single date (YYYY-MM-DD)
  start..end   Date range (inclusive, YYYY-MM-DD..YYYY-MM-DD)
  YYYY-Www     ISO week (e.g., 2026-W08)
  YYYY-MM      Month (e.g., 2026-02)

Options:
  --weekly     Generate a weekly summary instead of daily
  --monthly    Generate a monthly summary instead of daily
  --force      Regenerate existing summaries
  --help, -h   Show this help message

Examples:
  npx commit-story summarize 2026-02-22
  npx commit-story summarize 2026-02-01..2026-02-20
  npx commit-story summarize 2026-02-22 --force
  npx commit-story summarize --weekly 2026-W08
  npx commit-story summarize --weekly 2026-W08 --force
  npx commit-story summarize --monthly 2026-02
  npx commit-story summarize --monthly 2026-02 --force
`;
  console.log(helpText); // eslint-disable-line no-console
}

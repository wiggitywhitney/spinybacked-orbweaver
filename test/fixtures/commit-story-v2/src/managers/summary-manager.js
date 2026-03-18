// ABOUTME: Test fixture — daily/weekly/monthly summary orchestration; 14 functions including 5 async generation entry points.
// ABOUTME: Run-5 PARTIAL (4 spans): 5 functions failed NDS-003/COV-003; committed code has NDS-005b violations on expected-condition catches; run-4: 3 spans.

import { readFile, writeFile, access, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { generateDailySummary, generateWeeklySummary, generateMonthlySummary } from '../generators/summary-graph.js';
import {
  getJournalEntryPath,
  getSummaryPath,
  getSummariesDirectory,
  getDateString,
  getISOWeekString,
  ensureDirectory,
} from '../utils/journal-paths.js';

/** Separator between journal entries (matches journal-manager.js) */
const ENTRY_SEPARATOR = '═══════════════════════════════════════';

/**
 * Read all journal entries for a given date.
 * Splits the day's entry file by separator into individual entries.
 * @param {Date} date - Date to read entries for
 * @param {string} basePath - Base path for journal (default: current directory)
 * @returns {Promise<string[]>} Array of individual entry strings
 */
export async function readDayEntries(date, basePath = '.') {
  const entryPath = getJournalEntryPath(date, basePath);

  let content;
  try {
    content = await readFile(entryPath, 'utf-8');
  } catch {
    return [];
  }

  if (!content || !content.trim()) {
    return [];
  }

  // Split by separator, filter out empty parts
  const entries = content
    .split(ENTRY_SEPARATOR)
    .map(e => e.trim())
    .filter(e => e.length > 0);

  return entries;
}

/**
 * Format daily summary sections into markdown output.
 * @param {{ narrative: string, keyDecisions: string, openThreads: string }} sections - Summary sections
 * @param {string} dateStr - Date string (YYYY-MM-DD) for the header
 * @returns {string} Formatted markdown summary
 */
export function formatDailySummary(sections, dateStr) {
  const lines = [];

  lines.push(`# Daily Summary — ${dateStr}`);
  lines.push('');
  lines.push('## Narrative');
  lines.push('');
  lines.push(sections.narrative || '[No narrative generated]');
  lines.push('');
  lines.push('## Key Decisions');
  lines.push('');
  lines.push(sections.keyDecisions || 'No key decisions documented today.');
  lines.push('');
  lines.push('## Open Threads');
  lines.push('');
  lines.push(sections.openThreads || 'No open threads identified.');
  lines.push('');

  return lines.join('\n');
}

/**
 * Save a daily summary to the summaries directory.
 * Checks for existing file to prevent duplicates (DD-003).
 * @param {string} content - Formatted markdown summary
 * @param {Date} date - Date for the summary
 * @param {string} basePath - Base path for journal (default: current directory)
 * @param {{ force?: boolean }} options - Options
 * @returns {Promise<string|null>} Path to saved file, or null if skipped
 */
export async function saveDailySummary(content, date, basePath = '.', options = {}) {
  const summaryPath = getSummaryPath('daily', date, basePath);

  // Check for existing summary (DD-003: file existence for duplicate detection)
  if (!options.force) {
    try {
      await access(summaryPath);
      // File exists, skip
      return null;
    } catch {
      // File doesn't exist, proceed
    }
  }

  await ensureDirectory(summaryPath);
  await writeFile(summaryPath, content, 'utf-8');

  return summaryPath;
}

/**
 * Full pipeline: read entries for a date, generate summary, save to file.
 * @param {Date} date - Date to generate summary for
 * @param {string} basePath - Base path for journal (default: current directory)
 * @param {{ force?: boolean }} options - Options
 * @returns {Promise<{ saved: boolean, path?: string, reason?: string, entryCount?: number, errors?: string[] }>}
 */
export async function generateAndSaveDailySummary(date, basePath = '.', options = {}) {
  const dateStr = getDateString(date);

  // Check for existing summary first (avoid reading entries unnecessarily)
  if (!options.force) {
    const summaryPath = getSummaryPath('daily', date, basePath);
    try {
      await access(summaryPath);
      return { saved: false, reason: `Summary already exists for ${dateStr}` };
    } catch {
      // Doesn't exist, proceed
    }
  }

  // Read entries for the date
  const entries = await readDayEntries(date, basePath);
  if (entries.length === 0) {
    return { saved: false, reason: `Skipped ${dateStr}: no entries found` };
  }

  // Generate summary via LangGraph
  const result = await generateDailySummary(entries, dateStr);

  // Format the output
  const formatted = formatDailySummary(result, dateStr);

  // Save to file
  const path = await saveDailySummary(formatted, date, basePath, options);

  if (!path) {
    return { saved: false, reason: `Summary already exists for ${dateStr}` };
  }

  return {
    saved: true,
    path,
    entryCount: entries.length,
    errors: result.errors || [],
  };
}

// ---------------------------------------------------------------------------
// Weekly summary pipeline
// ---------------------------------------------------------------------------

/**
 * Get the Monday and Sunday dates for an ISO week.
 * @param {string} weekStr - ISO week string like "2026-W09"
 * @returns {{ monday: Date, sunday: Date }} Start and end dates of the week
 */
export function getWeekBoundaries(weekStr) {
  const match = weekStr.match(/^(\d{4})-W(\d{2})$/);
  if (!match) {
    throw new Error(`Invalid ISO week string: "${weekStr}". Expected format: YYYY-Www`);
  }

  const [, yearStr, weekStr2] = match;
  const year = parseInt(yearStr);
  const week = parseInt(weekStr2);

  // ISO week 1 contains the first Thursday of the year.
  // Find Jan 4 (always in week 1), then back up to Monday of that week.
  const jan4 = new Date(year, 0, 4);
  const jan4Day = jan4.getDay() || 7; // Convert Sunday from 0 to 7
  const week1Monday = new Date(jan4);
  week1Monday.setDate(jan4.getDate() - (jan4Day - 1));

  // Target week's Monday
  const monday = new Date(week1Monday);
  monday.setDate(week1Monday.getDate() + (week - 1) * 7);

  // Sunday = Monday + 6 days
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);

  return { monday, sunday };
}

/**
 * Read all daily summaries for a given ISO week.
 * Scans the daily summaries directory for files within the week's date range.
 * @param {string} weekStr - ISO week string like "2026-W09"
 * @param {string} basePath - Base path for journal (default: current directory)
 * @returns {Promise<Array<{ date: string, content: string }>>} Daily summaries sorted by date
 */
export async function readWeekDailySummaries(weekStr, basePath = '.') {
  const { monday, sunday } = getWeekBoundaries(weekStr);

  const summaries = [];

  // Check each day in the week
  const current = new Date(monday);
  while (current <= sunday) {
    const dateStr = getDateString(current);
    const dailyPath = getSummaryPath('daily', current, basePath);

    try {
      const content = await readFile(dailyPath, 'utf-8');
      if (content && content.trim()) {
        summaries.push({ date: dateStr, content: content.trim() });
      }
    } catch {
      // No daily summary for this day — skip
    }

    current.setDate(current.getDate() + 1);
  }

  return summaries;
}

/**
 * Format weekly summary sections into markdown output.
 * @param {{ weekInReview: string, highlights: string, patterns: string }} sections - Summary sections
 * @param {string} weekStr - ISO week string for the header
 * @returns {string} Formatted markdown summary
 */
export function formatWeeklySummary(sections, weekStr) {
  const lines = [];

  lines.push(`# Weekly Summary — ${weekStr}`);
  lines.push('');
  lines.push('## Week in Review');
  lines.push('');
  lines.push(sections.weekInReview || '[No weekly narrative generated]');
  lines.push('');
  lines.push('## Highlights');
  lines.push('');
  lines.push(sections.highlights || 'No standout highlights this week.');
  lines.push('');
  lines.push('## Patterns');
  lines.push('');
  lines.push(sections.patterns || 'No notable patterns this week.');
  lines.push('');

  return lines.join('\n');
}

/**
 * Save a weekly summary to the summaries directory.
 * Checks for existing file to prevent duplicates (DD-003).
 * @param {string} content - Formatted markdown summary
 * @param {string} weekStr - ISO week string
 * @param {string} basePath - Base path for journal (default: current directory)
 * @param {{ force?: boolean }} options - Options
 * @returns {Promise<string|null>} Path to saved file, or null if skipped
 */
export async function saveWeeklySummary(content, weekStr, basePath = '.', options = {}) {
  // Use any date in the week to compute the path (Monday)
  const { monday } = getWeekBoundaries(weekStr);
  const summaryPath = getSummaryPath('weekly', monday, basePath);

  // Check for existing summary (DD-003)
  if (!options.force) {
    try {
      await access(summaryPath);
      return null;
    } catch {
      // Doesn't exist, proceed
    }
  }

  await ensureDirectory(summaryPath);
  await writeFile(summaryPath, content, 'utf-8');

  return summaryPath;
}

/**
 * Full pipeline: read daily summaries for a week, generate weekly summary, save to file.
 * @param {string} weekStr - ISO week string like "2026-W09"
 * @param {string} basePath - Base path for journal (default: current directory)
 * @param {{ force?: boolean }} options - Options
 * @returns {Promise<{ saved: boolean, path?: string, reason?: string, dayCount?: number, errors?: string[] }>}
 */
export async function generateAndSaveWeeklySummary(weekStr, basePath = '.', options = {}) {
  // Check for existing summary first
  if (!options.force) {
    const { monday } = getWeekBoundaries(weekStr);
    const summaryPath = getSummaryPath('weekly', monday, basePath);
    try {
      await access(summaryPath);
      return { saved: false, reason: `Weekly summary already exists for ${weekStr}` };
    } catch {
      // Doesn't exist, proceed
    }
  }

  // Read daily summaries for the week
  const dailySummaries = await readWeekDailySummaries(weekStr, basePath);
  if (dailySummaries.length === 0) {
    return { saved: false, reason: `Skipped ${weekStr}: no daily summaries found` };
  }

  // Generate weekly summary via LangGraph
  const result = await generateWeeklySummary(dailySummaries, weekStr);

  // Format the output
  const formatted = formatWeeklySummary(result, weekStr);

  // Save to file
  const path = await saveWeeklySummary(formatted, weekStr, basePath, options);

  if (!path) {
    return { saved: false, reason: `Weekly summary already exists for ${weekStr}` };
  }

  return {
    saved: true,
    path,
    dayCount: dailySummaries.length,
    errors: result.errors || [],
  };
}

// ---------------------------------------------------------------------------
// Monthly summary pipeline
// ---------------------------------------------------------------------------

/**
 * Get the first and last day of a month.
 * @param {string} monthStr - Month string like "2026-02"
 * @returns {{ firstDay: Date, lastDay: Date }} Start and end dates of the month
 */
export function getMonthBoundaries(monthStr) {
  const match = monthStr.match(/^(\d{4})-(\d{2})$/);
  if (!match) {
    throw new Error(`Invalid month string: "${monthStr}". Expected format: YYYY-MM`);
  }

  const [, yearStr, monthNumStr] = match;
  const year = parseInt(yearStr);
  const month = parseInt(monthNumStr);

  if (month < 1 || month > 12) {
    throw new Error(`Invalid month string: "${monthStr}". Expected format: YYYY-MM`);
  }

  const firstDay = new Date(year, month - 1, 1);
  // Last day: day 0 of the next month gives the last day of the current month
  const lastDay = new Date(year, month, 0);

  return { firstDay, lastDay };
}

/**
 * Read all weekly summaries that overlap with a given month.
 * A week overlaps if any day of the week (Monday-Sunday) falls within the month.
 * @param {string} monthStr - Month string like "2026-02"
 * @param {string} basePath - Base path for journal (default: current directory)
 * @returns {Promise<Array<{ weekLabel: string, content: string }>>} Weekly summaries sorted by week
 */
export async function readMonthWeeklySummaries(monthStr, basePath = '.') {
  const { firstDay, lastDay } = getMonthBoundaries(monthStr);
  const weeklyDir = getSummariesDirectory('weekly', basePath);

  let files;
  try {
    files = await readdir(weeklyDir);
  } catch {
    return [];
  }

  const weekPattern = /^(\d{4}-W\d{2})\.md$/;
  const summaries = [];

  for (const file of files.sort()) {
    const match = file.match(weekPattern);
    if (!match) continue;

    const weekLabel = match[1];

    // Check if this week overlaps with the month
    // Import getWeekBoundaries locally to avoid circular dependency concerns
    const { monday, sunday } = getWeekBoundaries(weekLabel);

    // Week overlaps with month if week's Sunday >= month's first day AND week's Monday <= month's last day
    if (sunday >= firstDay && monday <= lastDay) {
      try {
        const content = await readFile(join(weeklyDir, file), 'utf-8');
        if (content && content.trim()) {
          summaries.push({ weekLabel, content: content.trim() });
        }
      } catch {
        // Skip unreadable files
      }
    }
  }

  return summaries;
}

/**
 * Format monthly summary sections into markdown output.
 * @param {{ monthInReview: string, accomplishments: string, growth: string, lookingAhead: string }} sections
 * @param {string} monthStr - Month string for the header
 * @returns {string} Formatted markdown summary
 */
export function formatMonthlySummary(sections, monthStr) {
  const lines = [];

  lines.push(`# Monthly Summary — ${monthStr}`);
  lines.push('');
  lines.push('## Month in Review');
  lines.push('');
  lines.push(sections.monthInReview || '[No monthly narrative generated]');
  lines.push('');
  lines.push('## Accomplishments');
  lines.push('');
  lines.push(sections.accomplishments || 'No standout accomplishments this month.');
  lines.push('');
  lines.push('## Growth');
  lines.push('');
  lines.push(sections.growth || 'No notable growth signals this month.');
  lines.push('');
  lines.push('## Looking Ahead');
  lines.push('');
  lines.push(sections.lookingAhead || 'No open threads carrying into next month.');
  lines.push('');

  return lines.join('\n');
}

/**
 * Save a monthly summary to the summaries directory.
 * Checks for existing file to prevent duplicates (DD-003).
 * @param {string} content - Formatted markdown summary
 * @param {string} monthStr - Month string like "2026-02"
 * @param {string} basePath - Base path for journal (default: current directory)
 * @param {{ force?: boolean }} options - Options
 * @returns {Promise<string|null>} Path to saved file, or null if skipped
 */
export async function saveMonthlySummary(content, monthStr, basePath = '.', options = {}) {
  const { firstDay } = getMonthBoundaries(monthStr);
  const summaryPath = getSummaryPath('monthly', firstDay, basePath);

  // Check for existing summary (DD-003)
  if (!options.force) {
    try {
      await access(summaryPath);
      return null;
    } catch {
      // Doesn't exist, proceed
    }
  }

  await ensureDirectory(summaryPath);
  await writeFile(summaryPath, content, 'utf-8');

  return summaryPath;
}

/**
 * Full pipeline: read weekly summaries for a month, generate monthly summary, save to file.
 * @param {string} monthStr - Month string like "2026-02"
 * @param {string} basePath - Base path for journal (default: current directory)
 * @param {{ force?: boolean }} options - Options
 * @returns {Promise<{ saved: boolean, path?: string, reason?: string, weekCount?: number, errors?: string[] }>}
 */
export async function generateAndSaveMonthlySummary(monthStr, basePath = '.', options = {}) {
  // Check for existing summary first
  if (!options.force) {
    const { firstDay } = getMonthBoundaries(monthStr);
    const summaryPath = getSummaryPath('monthly', firstDay, basePath);
    try {
      await access(summaryPath);
      return { saved: false, reason: `Monthly summary already exists for ${monthStr}` };
    } catch {
      // Doesn't exist, proceed
    }
  }

  // Read weekly summaries for the month
  const weeklySummaries = await readMonthWeeklySummaries(monthStr, basePath);
  if (weeklySummaries.length === 0) {
    return { saved: false, reason: `Skipped ${monthStr}: no weekly summaries found` };
  }

  // Generate monthly summary via LangGraph
  const result = await generateMonthlySummary(weeklySummaries, monthStr);

  // Format the output
  const formatted = formatMonthlySummary(result, monthStr);

  // Save to file
  const path = await saveMonthlySummary(formatted, monthStr, basePath, options);

  if (!path) {
    return { saved: false, reason: `Monthly summary already exists for ${monthStr}` };
  }

  return {
    saved: true,
    path,
    weekCount: weeklySummaries.length,
    errors: result.errors || [],
  };
}

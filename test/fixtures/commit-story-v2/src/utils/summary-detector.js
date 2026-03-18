// ABOUTME: Test fixture — detects journal dates/weeks/months with missing summaries; 4 exported async functions scanning filesystem.
// ABOUTME: Run-5 PARTIAL (4 spans): getDaysWithDailySummaries failed COV-003 on expected-condition readdir catch; committed code has NDS-005b violations; run-4: 5 spans.

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { getISOWeekString, getYearMonth } from './journal-paths.js';

/**
 * Get the current date string in the configured timezone.
 * Uses COMMIT_STORY_TIMEZONE if set, otherwise system local time.
 * @returns {string} Date string in YYYY-MM-DD format
 */
function getTodayString() {
  const tz = process.env.COMMIT_STORY_TIMEZONE || null;
  if (tz) {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    return fmt.format(new Date());
  }
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Get a Date object representing "now" in the configured timezone.
 * @returns {Date} Date object for current time in configured timezone
 */
function getNowDate() {
  const tz = process.env.COMMIT_STORY_TIMEZONE || null;
  if (tz) {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    const [year, month, day] = fmt.format(new Date()).split('-').map(Number);
    return new Date(year, month - 1, day);
  }
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

/**
 * Get all dates that have journal entry files.
 * Scans all YYYY-MM subdirectories under journal/entries/ for YYYY-MM-DD.md files.
 * @param {string} basePath - Base path for journal (default: current directory)
 * @returns {Promise<string[]>} Sorted array of date strings (YYYY-MM-DD)
 */
export async function getDaysWithEntries(basePath = '.') {
  const entriesDir = join(basePath, 'journal', 'entries');
  const datePattern = /^\d{4}-\d{2}-\d{2}\.md$/;

  let monthDirs;
  try {
    monthDirs = await readdir(entriesDir);
  } catch {
    return [];
  }

  const dates = [];

  for (const monthDir of monthDirs) {
    // Only process YYYY-MM directories
    if (!/^\d{4}-\d{2}$/.test(monthDir)) continue;

    let files;
    try {
      files = await readdir(join(entriesDir, monthDir));
    } catch {
      continue;
    }

    for (const file of files) {
      if (datePattern.test(file)) {
        dates.push(file.replace('.md', ''));
      }
    }
  }

  dates.sort();
  return dates;
}

/**
 * Get all dates that have daily summary files.
 * @param {string} basePath - Base path for journal (default: current directory)
 * @returns {Promise<Set<string>>} Set of date strings (YYYY-MM-DD)
 */
async function getSummarizedDays(basePath = '.') {
  const summariesDir = join(basePath, 'journal', 'summaries', 'daily');
  const datePattern = /^\d{4}-\d{2}-\d{2}\.md$/;

  let files;
  try {
    files = await readdir(summariesDir);
  } catch {
    return new Set();
  }

  const dates = new Set();
  for (const file of files) {
    if (datePattern.test(file)) {
      dates.add(file.replace('.md', ''));
    }
  }
  return dates;
}

/**
 * Find days that have journal entries but no daily summary.
 * Excludes today (current day is not yet complete).
 * @param {string} basePath - Base path for journal (default: current directory)
 * @param {{ before?: string }} options - Optional cutoff date (exclusive, YYYY-MM-DD)
 * @returns {Promise<string[]>} Sorted array of unsummarized date strings
 */
export async function findUnsummarizedDays(basePath = '.', options = {}) {
  const entryDays = await getDaysWithEntries(basePath);
  if (entryDays.length === 0) return [];

  const summarizedDays = await getSummarizedDays(basePath);
  const today = getTodayString();

  return entryDays.filter(dateStr => {
    // Exclude today — not yet complete
    if (dateStr >= today) return false;
    // Exclude dates at or after the cutoff
    if (options.before && dateStr >= options.before) return false;
    // Exclude already summarized
    if (summarizedDays.has(dateStr)) return false;
    return true;
  });
}

/**
 * Get all ISO week strings that have weekly summary files.
 * @param {string} basePath - Base path for journal (default: current directory)
 * @returns {Promise<Set<string>>} Set of week strings (YYYY-Www)
 */
async function getSummarizedWeeks(basePath = '.') {
  const summariesDir = join(basePath, 'journal', 'summaries', 'weekly');
  const weekPattern = /^\d{4}-W\d{2}\.md$/;

  let files;
  try {
    files = await readdir(summariesDir);
  } catch {
    return new Set();
  }

  const weeks = new Set();
  for (const file of files) {
    if (weekPattern.test(file)) {
      weeks.add(file.replace('.md', ''));
    }
  }
  return weeks;
}

/**
 * Get all dates that have daily summary files (as date strings).
 * @param {string} basePath - Base path for journal (default: current directory)
 * @returns {Promise<string[]>} Sorted array of date strings (YYYY-MM-DD)
 */
export async function getDaysWithDailySummaries(basePath = '.') {
  const summariesDir = join(basePath, 'journal', 'summaries', 'daily');
  const datePattern = /^\d{4}-\d{2}-\d{2}\.md$/;

  let files;
  try {
    files = await readdir(summariesDir);
  } catch {
    return [];
  }

  const dates = [];
  for (const file of files) {
    if (datePattern.test(file)) {
      dates.push(file.replace('.md', ''));
    }
  }
  dates.sort();
  return dates;
}

/**
 * Find ISO weeks that have daily summaries but no weekly summary.
 * Excludes the current week (not yet complete).
 * Groups daily summary dates into ISO weeks, then checks for existing weekly summaries.
 * @param {string} basePath - Base path for journal (default: current directory)
 * @returns {Promise<string[]>} Sorted array of unsummarized ISO week strings
 */
export async function findUnsummarizedWeeks(basePath = '.') {
  const dailySummaryDates = await getDaysWithDailySummaries(basePath);
  if (dailySummaryDates.length === 0) return [];

  // Group daily summary dates into ISO weeks
  const weeksWithSummaries = new Set();
  for (const dateStr of dailySummaryDates) {
    const [year, month, day] = dateStr.split('-').map(Number);
    const date = new Date(year, month - 1, day);
    const weekStr = getISOWeekString(date);
    weeksWithSummaries.add(weekStr);
  }

  // Get current week to exclude it (timezone-aware)
  const currentWeek = getISOWeekString(getNowDate());

  // Check which weeks already have weekly summaries
  const summarizedWeeks = await getSummarizedWeeks(basePath);

  const unsummarized = [];
  for (const weekStr of weeksWithSummaries) {
    // Exclude current week — not yet complete
    if (weekStr >= currentWeek) continue;
    // Exclude already summarized
    if (summarizedWeeks.has(weekStr)) continue;
    unsummarized.push(weekStr);
  }

  unsummarized.sort();
  return unsummarized;
}

/**
 * Get all month strings that have monthly summary files.
 * @param {string} basePath - Base path for journal (default: current directory)
 * @returns {Promise<Set<string>>} Set of month strings (YYYY-MM)
 */
async function getSummarizedMonths(basePath = '.') {
  const summariesDir = join(basePath, 'journal', 'summaries', 'monthly');
  const monthPattern = /^\d{4}-\d{2}\.md$/;

  let files;
  try {
    files = await readdir(summariesDir);
  } catch {
    return new Set();
  }

  const months = new Set();
  for (const file of files) {
    if (monthPattern.test(file)) {
      months.add(file.replace('.md', ''));
    }
  }
  return months;
}

/**
 * Get all week labels from weekly summary files.
 * @param {string} basePath - Base path for journal (default: current directory)
 * @returns {Promise<string[]>} Sorted array of week strings (YYYY-Www)
 */
async function getWeeksWithWeeklySummaries(basePath = '.') {
  const summariesDir = join(basePath, 'journal', 'summaries', 'weekly');
  const weekPattern = /^\d{4}-W\d{2}\.md$/;

  let files;
  try {
    files = await readdir(summariesDir);
  } catch {
    return [];
  }

  const weeks = [];
  for (const file of files) {
    if (weekPattern.test(file)) {
      weeks.push(file.replace('.md', ''));
    }
  }
  weeks.sort();
  return weeks;
}

/**
 * Find months that have weekly summaries but no monthly summary.
 * Excludes the current month (not yet complete).
 * Determines a week's month from its Monday date.
 * @param {string} basePath - Base path for journal (default: current directory)
 * @returns {Promise<string[]>} Sorted array of unsummarized month strings (YYYY-MM)
 */
export async function findUnsummarizedMonths(basePath = '.') {
  const weekLabels = await getWeeksWithWeeklySummaries(basePath);
  if (weekLabels.length === 0) return [];

  // Map week labels to their Monday's month
  const monthsWithWeeklies = new Set();
  for (const weekLabel of weekLabels) {
    const match = weekLabel.match(/^(\d{4})-W(\d{2})$/);
    if (!match) continue;

    const [, yearStr, weekNumStr] = match;
    const year = parseInt(yearStr);
    const week = parseInt(weekNumStr);

    // Calculate the Monday of this ISO week
    const jan4 = new Date(year, 0, 4);
    const jan4Day = jan4.getDay() || 7;
    const week1Monday = new Date(jan4);
    week1Monday.setDate(jan4.getDate() - (jan4Day - 1));

    const monday = new Date(week1Monday);
    monday.setDate(week1Monday.getDate() + (week - 1) * 7);

    const monthStr = getYearMonth(monday);
    monthsWithWeeklies.add(monthStr);
  }

  // Get current month to exclude it (timezone-aware)
  const currentMonth = getYearMonth(getNowDate());

  // Check which months already have monthly summaries
  const summarizedMonths = await getSummarizedMonths(basePath);

  const unsummarized = [];
  for (const monthStr of monthsWithWeeklies) {
    if (monthStr >= currentMonth) continue;
    if (summarizedMonths.has(monthStr)) continue;
    unsummarized.push(monthStr);
  }

  unsummarized.sort();
  return unsummarized;
}

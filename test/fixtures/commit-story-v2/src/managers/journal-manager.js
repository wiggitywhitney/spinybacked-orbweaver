// ABOUTME: Test fixture — journal entry save/discovery operations; saveJournalEntry and discoverReflections are async instrumentation targets.
// ABOUTME: Run-5 PARTIAL (1 span): discoverReflections failed COV-003 on filesystem expected-condition catches; committed code has NDS-005b violations.
/**
 * Journal Manager
 *
 * Handles journal entry formatting, file writing, and reflection discovery.
 * Uses fs/promises for async file operations and UTC-first time handling.
 */

import { readFile, appendFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  getJournalEntryPath,
  getReflectionsDirectory,
  ensureDirectory,
  parseDateFromFilename,
  getYearMonth,
} from '../utils/journal-paths.js';

/** Separator between journal entries */
const ENTRY_SEPARATOR = '\n═══════════════════════════════════════\n\n';

/**
 * Extract file paths from git diff headers
 * @param {string} diff - Git diff content
 * @returns {Array<string>} Array of file paths
 */
function extractFilesFromDiff(diff) {
  if (!diff) return [];
  const files = [];
  const lines = diff.split('\n');
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      const match = line.match(/diff --git a\/(.+) b\/.+/);
      if (match && match[1]) {
        files.push(match[1]);
      }
    }
  }
  return files;
}

/**
 * Count approximate lines changed from diff content
 * @param {string} diff - Git diff content
 * @returns {number} Approximate number of lines changed
 */
function countDiffLines(diff) {
  if (!diff) return 0;
  const lines = diff.split('\n');
  let count = 0;
  for (const line of lines) {
    if ((line.startsWith('+') && !line.startsWith('+++')) ||
        (line.startsWith('-') && !line.startsWith('---'))) {
      count++;
    }
  }
  return count;
}

/** Pattern to match reflection entry headers */
const REFLECTION_HEADER_PATTERN = /^## (\d{1,2}:\d{2}:\d{2} [AP]M \w+) - (.+?)$/m;

/**
 * Format timestamp for display in local time
 * @param {Date} date - Date object
 * @returns {string} Formatted time string like "10:15:32 AM CDT"
 */
export function formatTimestamp(date) {
  return date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
    timeZoneName: 'short',
  });
}

/**
 * Format reflections section for journal entry
 * @param {Array} reflections - Array of reflection objects
 * @returns {string} Formatted markdown section
 */
function formatReflectionsSection(reflections) {
  if (!reflections || reflections.length === 0) {
    return '';
  }

  const lines = ['### Developer Reflections', ''];
  for (const reflection of reflections) {
    const timeStr = formatTimestamp(reflection.timestamp);
    lines.push(`> ${timeStr} - "${reflection.content}"`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Format a complete journal entry
 * @param {Object} sections - Generated sections from AI
 * @param {string} sections.summary - Narrative summary
 * @param {string} sections.dialogue - Human quotes
 * @param {string} sections.technicalDecisions - Technical decisions
 * @param {Object} commit - Commit metadata
 * @param {string} commit.shortHash - Short commit hash
 * @param {string} commit.hash - Full commit hash
 * @param {string} commit.author - Commit author name
 * @param {Date} commit.timestamp - Commit timestamp
 * @param {number} commit.filesChanged - Number of files changed
 * @param {Array} reflections - Optional array of reflections
 * @returns {string} Formatted markdown entry
 */
export function formatJournalEntry(sections, commit, reflections = []) {
  const timeStr = formatTimestamp(commit.timestamp);
  const lines = [];

  // Header
  lines.push(`## ${timeStr} - Commit: ${commit.shortHash}`);
  lines.push('');

  // Summary section
  lines.push('### Summary');
  lines.push(sections.summary || '[No summary generated]');
  lines.push('');

  // Dialogue section
  lines.push('### Development Dialogue');
  lines.push(sections.dialogue || '[No dialogue extracted]');
  lines.push('');

  // Technical decisions section
  lines.push('### Technical Decisions');
  lines.push(sections.technicalDecisions || '[No decisions identified]');
  lines.push('');

  // Reflections section (if any)
  const reflectionsSection = formatReflectionsSection(reflections);
  if (reflectionsSection) {
    lines.push(reflectionsSection);
  }

  // Commit details (programmatic, matching v1 format)
  lines.push('### Commit Details');
  const filesChanged = extractFilesFromDiff(commit.diff);
  if (filesChanged.length > 0) {
    lines.push('**Files Changed**:');
    for (const file of filesChanged) {
      lines.push(`- ${file}`);
    }
    lines.push('');
  }
  const linesChanged = countDiffLines(commit.diff);
  if (linesChanged > 0) {
    lines.push(`**Lines Changed**: ~${linesChanged} lines`);
  }
  const commitMessage = (commit.message || '').split('\n')[0];
  if (commitMessage) {
    lines.push(`**Message**: "${commitMessage}"`);
  }
  lines.push('');

  // Entry separator
  lines.push(ENTRY_SEPARATOR.trim());

  return lines.join('\n');
}

/**
 * Save a journal entry for a commit
 * @param {Object} sections - Generated sections from AI
 * @param {Object} commit - Commit metadata with timestamp
 * @param {Array} reflections - Optional reflections to include
 * @param {string} basePath - Base path for journal (default: current directory)
 * @param {Object} [options] - Optional settings
 * @param {Function} [options.debug] - Debug logging function
 * @returns {Promise<string>} Path to saved file
 */
export async function saveJournalEntry(sections, commit, reflections = [], basePath = '.', options = {}) {
  const log = options.debug || (() => {});
  const entryPath = getJournalEntryPath(commit.timestamp, basePath);

  // Ensure directory exists
  await ensureDirectory(entryPath);

  // Check for duplicate entry
  try {
    const existing = await readFile(entryPath, 'utf-8');

    // Path 1: Exact hash match (catches re-runs of the same commit)
    if (existing.includes(`Commit: ${commit.shortHash}`)) {
      log(`Skipping duplicate entry: exact hash match (${commit.shortHash})`);
      return entryPath;
    }

    // Path 2: Semantic match (catches cherry-pick/rebase duplicates)
    // Cherry-picks and rebases preserve author timestamp and commit message
    // but produce a new commit hash. Match on both to avoid false positives.
    // Split into entry blocks so we check timestamp+message within the SAME entry,
    // avoiding false positives when different entries share one field each.
    const timeStr = formatTimestamp(commit.timestamp);
    const commitMessage = (commit.message || '').split('\n')[0];
    const entryBlocks = existing.split('═══════════════════════════════════════');
    const isSemanticDup = commitMessage && entryBlocks.some(
      block => block.includes(`## ${timeStr}`) && block.includes(`**Message**: "${commitMessage}"`)
    );
    if (isSemanticDup) {
      log(`Skipping duplicate entry: semantic match — same timestamp (${timeStr}) and message ("${commitMessage}"), likely cherry-pick/rebase of ${commit.shortHash}`);
      return entryPath;
    }
  } catch {
    // File doesn't exist yet, proceed
  }

  // Format the entry
  const formattedEntry = formatJournalEntry(sections, commit, reflections);

  // Append to file (creates if doesn't exist)
  await appendFile(entryPath, formattedEntry + '\n', 'utf-8');

  return entryPath;
}

/**
 * Parse a single reflection entry from content
 * @param {string} content - Raw content of one entry
 * @param {Date} baseDate - Date from filename for combining with time
 * @returns {Object|null} Parsed reflection or null if invalid
 */
function parseReflectionEntry(content, baseDate) {
  const match = content.match(REFLECTION_HEADER_PATTERN);
  if (!match) {
    return null;
  }

  const [, timeStr, title] = match;
  const contentStart = content.indexOf('\n', content.indexOf(match[0])) + 1;
  const text = content.slice(contentStart).trim();

  // Parse time from header and combine with base date
  const timestamp = parseTimeString(timeStr, baseDate);
  if (!timestamp) {
    return null;
  }

  return {
    timestamp,
    title,
    content: text,
  };
}

/**
 * Parse time string like "9:45:00 AM CDT" and combine with base date
 * @param {string} timeStr - Time string from reflection header
 * @param {Date} baseDate - Base date to combine with
 * @returns {Date|null} Combined date/time or null if parse fails
 */
function parseTimeString(timeStr, baseDate) {
  // Match pattern: "9:45:00 AM CDT" or "10:15:32 PM EST"
  const match = timeStr.match(/^(\d{1,2}):(\d{2}):(\d{2}) ([AP]M)/);
  if (!match) {
    return null;
  }

  const [, hourStr, minute, second, ampm] = match;
  let hour = parseInt(hourStr, 10);

  // Convert to 24-hour format
  if (ampm === 'PM' && hour !== 12) {
    hour += 12;
  } else if (ampm === 'AM' && hour === 12) {
    hour = 0;
  }

  // Create new date with parsed time (in local timezone)
  const result = new Date(baseDate);
  result.setHours(hour, parseInt(minute, 10), parseInt(second, 10), 0);

  return result;
}

/**
 * Parse all reflections from a reflection file
 * @param {string} content - Full file content
 * @param {Date} baseDate - Date from filename
 * @returns {Array} Array of parsed reflections
 */
function parseReflectionsFile(content, baseDate) {
  const SEPARATOR = '═══════════════════════════════════════';
  const parts = content.split(SEPARATOR);
  const reflections = [];

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) {
      continue;
    }

    const reflection = parseReflectionEntry(trimmed, baseDate);
    if (reflection) {
      reflections.push(reflection);
    }
  }

  return reflections;
}

/**
 * Check if a timestamp falls within a time window
 * Uses UTC milliseconds for accurate comparison
 * @param {Date} timestamp - Timestamp to check
 * @param {Date} startTime - Window start
 * @param {Date} endTime - Window end
 * @returns {boolean} True if timestamp is within window
 */
function isInTimeWindow(timestamp, startTime, endTime) {
  const time = timestamp.getTime();
  return time >= startTime.getTime() && time <= endTime.getTime();
}

/**
 * Discover reflections within a time window
 * @param {Date} startTime - Beginning of window (usually previous commit time)
 * @param {Date} endTime - End of window (usually current commit time)
 * @param {string} basePath - Base path for journal (default: current directory)
 * @returns {Promise<Array>} Array of reflections sorted chronologically
 */
export async function discoverReflections(startTime, endTime, basePath = '.') {
  const reflections = [];

  // Get all year-month directories that could contain relevant reflections
  const startYearMonth = getYearMonth(startTime);
  const endYearMonth = getYearMonth(endTime);
  const yearMonths = getYearMonthRange(startYearMonth, endYearMonth);

  for (const yearMonth of yearMonths) {
    const reflectionsDir = join(basePath, 'journal', 'reflections', yearMonth);

    try {
      const files = await readdir(reflectionsDir);

      for (const file of files) {
        if (!file.endsWith('.md')) {
          continue;
        }

        const fileDate = parseDateFromFilename(file);
        if (!fileDate) {
          continue;
        }

        // Quick check: skip files outside the date range
        // (dates are at start of day, so include if within range)
        const fileDateEnd = new Date(fileDate);
        fileDateEnd.setHours(23, 59, 59, 999);

        if (fileDateEnd.getTime() < startTime.getTime()) {
          continue;
        }
        if (fileDate.getTime() > endTime.getTime()) {
          continue;
        }

        // Read and parse reflections from file
        const filePath = join(reflectionsDir, file);
        try {
          const content = await readFile(filePath, 'utf-8');
          const fileReflections = parseReflectionsFile(content, fileDate);

          // Filter to time window
          for (const reflection of fileReflections) {
            if (isInTimeWindow(reflection.timestamp, startTime, endTime)) {
              reflections.push({
                ...reflection,
                filePath,
              });
            }
          }
        } catch {
          // Skip files that can't be read
          continue;
        }
      }
    } catch {
      // Directory doesn't exist, skip
      continue;
    }
  }

  // Sort chronologically
  reflections.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

  return reflections;
}


/**
 * Get all year-months between start and end (inclusive)
 * @param {string} start - Start YYYY-MM
 * @param {string} end - End YYYY-MM
 * @returns {Array<string>} Array of YYYY-MM strings
 */
function getYearMonthRange(start, end) {
  const result = [];
  const [startYear, startMonth] = start.split('-').map(Number);
  const [endYear, endMonth] = end.split('-').map(Number);

  let year = startYear;
  let month = startMonth;

  while (year < endYear || (year === endYear && month <= endMonth)) {
    result.push(`${year}-${String(month).padStart(2, '0')}`);
    month++;
    if (month > 12) {
      month = 1;
      year++;
    }
  }

  return result;
}

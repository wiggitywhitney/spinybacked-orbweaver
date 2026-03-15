// ABOUTME: Test fixture — complex module with exported functions, constants, and imports
// ABOUTME: Used for function extraction testing (PRD #106 function-level instrumentation)
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const MAX_RETRIES = 3;
const DEFAULT_TIMEOUT = 5000;
const CACHE = new Map();

/**
 * Fetch a resource with retry logic.
 * @param {string} url - The URL to fetch
 * @param {object} options - Fetch options
 * @returns {Promise<Response>}
 */
export async function fetchWithRetry(url, options = {}) {
  let lastError;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT),
      });
      if (response.ok) return response;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

/**
 * Read and parse a JSON configuration file.
 */
export async function loadConfig(configPath) {
  const resolved = path.resolve(configPath);
  const content = await readFile(resolved, 'utf-8');
  return JSON.parse(content);
}

/**
 * Save data to a file.
 */
export async function saveData(filePath, data) {
  const resolved = path.resolve(filePath);
  const content = JSON.stringify(data, null, 2);
  await writeFile(resolved, content, 'utf-8');
}

// Already instrumented function — should be skipped
export function processRequest(req) {
  return tracer.startActiveSpan('processRequest', (span) => {
    try {
      const result = { status: 200, body: req.body };
      span.setAttribute('http.status_code', result.status);
      return result;
    } catch (error) {
      span.recordException(error);
      span.setStatus({ code: 2 });
      throw error;
    } finally {
      span.end();
    }
  });
}

// Trivial function — should be skipped (< 3 statements)
export function getVersion() {
  return '1.0.0';
}

// Another trivial one
export const getName = () => 'my-service';

// Non-exported internal helper — should be skipped (not exported)
async function retryDelay(attempt) {
  const delay = Math.pow(2, attempt) * 100;
  await new Promise(resolve => setTimeout(resolve, delay));
}

// Exported arrow function with sufficient complexity
export const transformData = async (input) => {
  const cached = CACHE.get(input.id);
  if (cached) return cached;

  const result = {
    id: input.id,
    name: input.name.trim(),
    timestamp: Date.now(),
    processed: true,
  };

  CACHE.set(input.id, result);
  return result;
};

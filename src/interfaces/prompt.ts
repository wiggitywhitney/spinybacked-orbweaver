// ABOUTME: Simple stdin prompt for CLI confirmation flows.
// ABOUTME: Reads a single line from stdin and checks for affirmative response.

import { createInterface } from 'node:readline';

/**
 * Prompt the user for confirmation via stdin/stdout.
 * Returns true if the user enters 'y' or 'yes' (case-insensitive).
 *
 * @param message - The prompt message to display
 * @returns true if user confirms, false otherwise
 */
export async function promptConfirm(message: string): Promise<boolean> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
  });

  return new Promise((resolve) => {
    rl.question(message, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

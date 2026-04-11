// ABOUTME: Generic TypeScript utility fixture for golden file tests.
// ABOUTME: Demonstrates generic type parameters that must survive instrumentation unchanged.

/**
 * Process a list of items by applying an async transform function to each one.
 * Type parameters T (input) and R (output) must be preserved after instrumentation.
 */
export async function processItems<T, R>(
  items: T[],
  transform: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (const item of items) {
    const result = await transform(item);
    results.push(result);
  }
  return results;
}

/**
 * Identity function — returns its input unchanged. Type parameter must be preserved.
 */
export function identity<T>(value: T): T {
  return value;
}

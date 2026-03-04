// ABOUTME: Test fixture — pure utility functions that should NOT be instrumented.
// ABOUTME: Tests RST-001 (pure function detection) — short synchronous helpers.
export function formatCurrency(amount) {
  return `$${amount.toFixed(2)}`;
}

export function formatDate(date) {
  return date.toISOString().split('T')[0];
}

export function slugify(text) {
  return text.toLowerCase().replace(/\s+/g, '-').replace(/[^\w-]+/g, '');
}

export function truncate(text, maxLength) {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + '...';
}

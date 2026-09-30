/*
 * The order tabs were last used in, most recent first — what Ctrl+Tab walks, the way Alt+Tab walks
 * windows. Kept apart from the tab strip's own order, which is where the reader *put* the tabs
 * rather than when they last looked at them.
 */

/** `id` becomes the most recent. */
export function touch(history: string[], id: string): string[] {
  return [id, ...history.filter((h) => h !== id)];
}

/**
 * The tabs in switching order: most recently used first, with any tab never yet looked at (opened
 * in the background) after those, in strip order. Closed tabs drop out.
 */
export function switchOrder(history: string[], tabIds: string[]): string[] {
  const open = new Set(tabIds);
  const seen = history.filter((id) => open.has(id));
  const rest = tabIds.filter((id) => !seen.includes(id));
  return [...seen, ...rest];
}

/** Step `by` places through a list of `length`, wrapping at both ends. */
export function stepIndex(index: number, by: number, length: number): number {
  return length === 0 ? 0 : (((index + by) % length) + length) % length;
}

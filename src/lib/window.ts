/**
 * The visible window's identity, independent of React.
 *
 * Kept here rather than in the hook so `scripts/test.mjs` can cover it: the hook
 * pulls in React and the SDK, and a regression here is invisible to a unit test
 * that only sees the pure modules. It was exactly such a regression — a range
 * rebuilt on every render — that closed the drill-down panel the instant a click
 * opened it, while every other test stayed green.
 */

/** A window selection: an interval preset, or one concrete month. */
export type WindowSelection =
  | { kind: 'interval'; code: string }
  | { kind: 'month'; key: string };

export interface DateWindow {
  from?: Date;
  to?: Date;
}

/** Resolves a preset code to its bounds. Generic in the code type so the host's
 *  own `TimePeriod` can be used without widening it to `string`. */
export type IntervalRangeResolver<C extends string = string> = (code: C) => DateWindow | undefined;

/** Inclusive bounds of a `YYYY-MM` month. */
export function monthRange(key: string): { from: Date; to: Date } {
  const [year, month] = key.split('-').map((part) => Number.parseInt(part, 10));
  const from = new Date(year, month - 1, 1);
  // Day 0 of the next month is the last day of this one.
  const to = new Date(year, month, 0, 23, 59, 59, 999);
  return { from, to };
}

/**
 * Resolves a selection to bounds, via the host's interval table.
 *
 * The host owns the preset table, so it is injected rather than duplicated here:
 * an addon copy would drift from the application the moment a preset changed.
 */
export function rangeFor<C extends string>(
  selection: { kind: 'interval'; code: C } | { kind: 'month'; key: string },
  intervalRange: IntervalRangeResolver<C>,
): DateWindow {
  if (selection.kind === 'month') return monthRange(selection.key);
  return intervalRange(selection.code) ?? {};
}

/** True when two windows name the same instant range. */
export function sameWindow(a: DateWindow | undefined, b: DateWindow | undefined): boolean {
  if (!a || !b) return a === b;

  const sameBound = (x: Date | undefined, y: Date | undefined) =>
    x === undefined ? y === undefined : y !== undefined && x.getTime() === y.getTime();

  return sameBound(a.from, b.from) && sameBound(a.to, b.to);
}

/**
 * The previous window when it names the same instants, a fresh one otherwise.
 *
 * Every caller wants an object it can put in a dependency array. Returning the
 * previous instance when the instants are unchanged is what makes that safe: a
 * range rebuilt on each render re-runs every effect keyed on it, and the
 * drill-down's reset effect then closed the panel in the same commit that the
 * click opened it.
 */
export function stableRange<C extends string>(
  selection: { kind: 'interval'; code: C } | { kind: 'month'; key: string },
  intervalRange: IntervalRangeResolver<C>,
  previous?: DateWindow,
): DateWindow {
  const next = rangeFor(selection, intervalRange);
  return sameWindow(previous, next) ? (previous as DateWindow) : next;
}
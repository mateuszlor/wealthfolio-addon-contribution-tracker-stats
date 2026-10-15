/**
 * Which series and stacks a view of the chart draws, as pure data.
 *
 * `ContributionChart` is series-generic: it renders whatever series it is handed
 * and reads the stack id off each one. Which series exist, and which stack each
 * belongs to, is a decision about the *view* — and it used to be made inside a
 * `useMemo` in `ContributionStatsPage`, where no test over the pure modules
 * could see it. That is how the per-account view lost its `stackId` and every
 * account started drawing its own narrow bar inside the band instead of the one
 * stacked column the README describes.
 *
 * Measured in the installed recharts (3.10.1), not assumed:
 *
 * - `state/types/StackedGraphicalItem.js` — `isStacked` is
 *   `'stackId' in item && item.stackId != null`. `stackId: undefined` is not
 *   "neutral", it is **not stacked**.
 * - `state/selectors/combiners/combineBarSizeList.js` — a bar with no stack id
 *   lands in `unstackedBars` and gets its own `sizeList` entry.
 * - `state/selectors/combiners/combineAllBarPositions.js` — every `sizeList`
 *   entry gets its own `offset` inside the band: `(size + barGap) * i`. That is
 *   the side-by-side layout, and the reason N series without a stack id look
 *   like N thin columns rather than one.
 *
 * So stacking is a property the caller must state, per series. This module is
 * that statement, and `scripts/test.mjs` asserts it.
 */

import type {
  Bucket,
  DirectionBucket,
  DirectionSplitResult,
  SplitResult,
} from './contributions';

/**
 * One series of the chart.
 *
 * `dataKey` is also a CSS identifier (it becomes `--color-<dataKey>`), so it
 * stays short: `s0`, `d1`, `w2`, `total`.
 */
export interface ChartSeries {
  /** Field name on each row. Kept short because it is also a CSS identifier. */
  dataKey: string;
  /**
   * Row label, as shown in the tooltip next to the amount.
   *
   * Short by design: a tooltip row shares one line with its amount, so this
   * truncates when it is long. Not the legend label — see `legendLabel`.
   */
  label: string;
  /**
   * Stack this series belongs to. Omit for a standalone bar.
   *
   * **Omitting is not the neutral case.** See the module comment: without a
   * stack id recharts draws the bar as one of several side-by-side bars inside
   * the band. Only a view that means exactly that — the `+/-` totals — leaves
   * it out on purpose.
   */
  stackId?: string;
  /**
   * Tooltip grouping header. Series sharing a group are collected under one
   * header row instead of each carrying the group's name.
   *
   * The per-account +/- view needs this: labelling each series "Obligacje ·
   * Deposits" made every row long enough that the last one truncated to
   * "Obligacje · Withdraw…". The direction is a property of the stack, not of
   * the account, so stating it once is both shorter and truer.
   */
  group?: string;
  /**
   * Legend entry, when it must differ from the tooltip row label.
   *
   * `ChartLegendContent` reads this and renders it at full width, where nothing
   * competes for the line — so the direction that the tooltip states once as a
   * group header belongs here, spelled out.
   */
  legendLabel?: string;
}

/** One period of the chart, carrying a value per series `dataKey`. */
export interface ChartRow {
  /** Human readable label for the axis (e.g., "Jan 2026"). */
  label: string;
  /** Machine-readable period key (e.g., "2026-01"). Used for drill-down filtering. */
  periodKey: string;
  [dataKey: string]: string | number;
}

/** What a view renders: the period rows, plus the series they carry. */
export interface ChartModel {
  rows: ChartRow[];
  series: ChartSeries[];
}

/** Labels the +/- view needs, translated by the caller. */
export interface DirectionLabels {
  deposits: string;
  withdrawals: string;
}

/**
 * The stack every account of a one-direction view shares.
 *
 * Every account of the period draws into **one** column, so they must all name
 * the same stack. Leaving this out is what the regression did.
 */
export const ACCOUNT_STACK = 'contributions';

/**
 * The two stacks of the +/- view.
 *
 * Deposits grow up from the axis, withdrawals grow down from it, so they need
 * two ids. Sharing one would collapse the downward column onto the upward one
 * and every period would read "nothing was withdrawn".
 */
export const DEPOSITS_STACK = 'deposits';
export const WITHDRAWALS_STACK = 'withdrawals';

/**
 * The one-direction total view: a single series, therefore a single bar and no
 * stack to speak of.
 */
export function totalView(buckets: Bucket[], label: string): ChartModel {
  return {
    rows: buckets.map((bucket) => ({
      label: bucket.label,
      periodKey: bucket.key,
      total: bucket.total,
    })),
    series: [{ dataKey: 'total', label }],
  };
}

/**
 * The per-account view of a one-direction ledger.
 *
 * One series per account, all in the same stack: a period's column is one bar
 * per account, stacked, with a stable segment order because `SplitBucket` is
 * zero-filled for every account.
 */
export function perAccountView(split: SplitResult): ChartModel {
  const series: ChartSeries[] = split.accounts.map((account, index) => ({
    dataKey: `s${index}`,
    label: account.name,
    // The whole point of the view: one column per period, one segment per
    // account. Without this id each account is its own bar in the band.
    stackId: ACCOUNT_STACK,
  }));

  const rows: ChartRow[] = split.buckets.map((bucket) => {
    const row: ChartRow = { label: bucket.label, periodKey: bucket.key };
    split.accounts.forEach((account, index) => {
      row[`s${index}`] = bucket.values[account.id] ?? 0;
    });
    return row;
  });

  return { rows, series };
}

/**
 * The +/- totals view: deposits above the axis, withdrawals below it.
 *
 * Neither series names a stack, and that is deliberate — the two bars of a
 * period must stay **side by side**, both growing from the axis in opposite
 * directions. Sharing a stack id would draw the withdrawal bar on top of the
 * deposit one.
 */
export function splitTotalView(buckets: DirectionBucket[], labels: DirectionLabels): ChartModel {
  return {
    rows: buckets.map((bucket) => ({
      label: bucket.label,
      periodKey: bucket.key,
      deposits: bucket.depositsTotal,
      // The sign is which key the value is under: recharts draws a negative
      // value below the axis. The chart never learns what a direction is.
      withdrawals: -bucket.withdrawalsTotal,
    })),
    series: [
      { dataKey: 'deposits', label: labels.deposits },
      { dataKey: 'withdrawals', label: labels.withdrawals },
    ],
  };
}

/**
 * The per-account +/- view: two stacks per period, one per direction.
 *
 * `bucketizeByDirection` keeps both maps unsigned, so the withdrawal sign is
 * applied here — again in the row, not in the chart.
 */
export function splitPerAccountView(split: DirectionSplitResult, labels: DirectionLabels): ChartModel {
  const series: ChartSeries[] = [];

  // The label is the account alone, and the direction moves to `group`:
  // labelled per row it was "Obligacje · Deposits", which truncated. The
  // direction is a property of the stack, not of the account, so stating it
  // once above its group is both shorter and truer.
  split.accounts.forEach((account, index) => {
    series.push({
      dataKey: `d${index}`,
      label: account.name,
      legendLabel: `${account.name} · ${labels.deposits}`,
      stackId: DEPOSITS_STACK,
      group: labels.deposits,
    });
  });

  split.accounts.forEach((account, index) => {
    series.push({
      dataKey: `w${index}`,
      label: account.name,
      legendLabel: `${account.name} · ${labels.withdrawals}`,
      stackId: WITHDRAWALS_STACK,
      group: labels.withdrawals,
    });
  });

  const rows: ChartRow[] = split.buckets.map((bucket) => {
    const row: ChartRow = { label: bucket.label, periodKey: bucket.key };
    split.accounts.forEach((account, index) => {
      row[`d${index}`] = bucket.deposits[account.id] ?? 0;
      row[`w${index}`] = -(bucket.withdrawals[account.id] ?? 0);
    });
    return row;
  });

  return { rows, series };
}

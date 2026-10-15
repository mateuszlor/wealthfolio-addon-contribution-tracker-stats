/**
 * Pure, dependency-free aggregation of contribution (deposit) records.
 *
 * Kept free of React and of the Wealthfolio SDK so it can be unit tested and
 * reasoned about on its own.
 */


/** Which money the page is showing at the moment. */
export type Flow = 'deposits' | 'withdrawals' | 'net' | 'split';

export type Granularity = 'month' | 'day' | 'year';

export interface ContributionRecord {
  /** Kind of money movement: adding to, or taking out of, the account. */
  flow: Flow;
  /** Moment the contribution or withdrawal was recorded. */
  date: Date;
  /** Positive flow amount, in the record's own currency. */
  amount: number;
  /** ISO currency code the host recorded the amount in. */
  currency: string;
  /** Account the deposit was recorded against. */
  accountId: string;
  /** Display name for the account; falls back to the id when unnamed. */
  accountName: string;
  /** Unique id of the activity (for drill-down). */
  activityId: string;
}

export interface Bucket {
  /** Sortable key, e.g. `2026-01`, `2026-01-15`, `2026`. */
  key: string;
  /** Human readable label for the axis. */
  label: string;
  total: number;
  count: number;
}

export interface Summary {
  total: number;
  count: number;
  /** Average contribution per record; 0 when there are no records. */
  average: number;
  /** Average per calendar month across the covered range; 0 when empty. */
  monthlyAverage: number;
  first?: string;
  last?: string;
}

const MONTHS_SHORT = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

const pad = (value: number): string => String(value).padStart(2, '0');

const isValidDate = (value: Date): boolean =>
  value instanceof Date && !Number.isNaN(value.getTime());

/** Coerces SDK payloads (`amount` is a string) into a finite positive number. */
export function toAmount(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string') {
    // Tolerate both `1234.56` and `1 234,56`.
    const normalised = value.replace(/\s/g, '').replace(',', '.');
    const parsed = Number.parseFloat(normalised);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

/** Coerces SDK payloads (`activityDate`) into a valid Date. */
export function toDate(value: unknown): Date | undefined {
  if (value instanceof Date) return isValidDate(value) ? value : undefined;
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value);
    return isValidDate(parsed) ? parsed : undefined;
  }
  return undefined;
}

/** Records behind one flow of the current view: kept, signed out, or both. */
export function selectFlow(
  records: ContributionRecord[],
  flow: Flow,
): ContributionRecord[] {
  if (flow !== 'net' && flow !== 'split') return records.filter((record) => record.flow === flow);
  return records;
}

/**
 * Signed value of one record for the ledger being displayed.
 *
 * All three views share one rule: money **added** is positive, money **taken
 * out** is negative. That is what makes the withdrawals view draw its bars
 * *below* the axis — a withdrawal is an outflow, so plotting it as a positive,
 * upward-growing column read as growth, which is exactly what hid the bug the
 * stacked view shipped with (one flow's bars drawn under the other's colour and
 * direction).
 *
 * - `deposits`: the caller has narrowed to `flow === 'deposits'`, so every
 *   record here is an inflow — signed up by construction.
 * - `withdrawals`: the records are outflows — always negative.
 * - `net`: both directions mixed, each record signed by its own flow.
 */
export function signedAmount(record: ContributionRecord, flow: Flow): number {
  switch (flow) {
    case 'deposits':
      return record.amount;
    case 'withdrawals':
      return -record.amount;
    case 'net':
    case 'split':
      return record.flow === 'withdrawals' ? -record.amount : record.amount;
    default:
      return record.amount;
  }
}

export function summarize(records: ContributionRecord[], flow: Flow = 'deposits'): Summary {
  if (records.length === 0) {
    return { total: 0, count: 0, average: 0, monthlyAverage: 0 };
  }

  let total = 0;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;

  for (const record of records) {
    // The net ledger signs withdrawals out, so total, average and the chart all
    // cancel deposits against withdrawals of the same period.
    total += signedAmount(record, flow);
    const time = record.date.getTime();
    if (time < min) min = time;
    if (time > max) max = time;
  }

  const first = new Date(min);
  const last = new Date(max);
  // Inclusive month span: Jan 2026 -> Jan 2026 is 1, not 0.
  const months =
    (last.getFullYear() - first.getFullYear()) * 12 +
    (last.getMonth() - first.getMonth()) +
    1;

  const toKey = (date: Date): string =>
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

  return {
    total,
    count: records.length,
    average: total / records.length,
    monthlyAverage: total / months,
    first: toKey(first),
    last: toKey(last),
  };
}

/** Inclusive date window, as produced by the host interval / range selectors. */
export interface DateWindow {
  from?: Date;
  to?: Date;
}

/** Keeps records inside the window. Bounds are inclusive when provided. */
export function filterByRange(
  records: ContributionRecord[],
  window: DateWindow,
): ContributionRecord[] {
  const { from, to } = window;
  if (!from && !to) return records;

  const lower = from ? from.getTime() : Number.NEGATIVE_INFINITY;
  const upper = to ? to.getTime() : Number.POSITIVE_INFINITY;

  return records.filter((record) => {
    const time = record.date.getTime();
    return time >= lower && time <= upper;
  });
}

/** Sortable key for the period a date belongs to: `2026`, `2026-01`, `2026-01-15`. */
export function periodKey(date: Date, granularity: Granularity): string {
  if (granularity === 'year') return String(date.getFullYear());
  return formatKey(date, granularity);
}

/** Groups records into chronological buckets of the requested granularity.
 *
 * Under the net view a withdrawal contributes its *negative* total, so a
 * bucket can total zero or below and `count` still counts both directions of
 * money.
 */
export function bucketize(
  records: ContributionRecord[],
  granularity: Granularity,
  locale = 'en',
  flow: Flow = 'deposits',
): Bucket[] {
  const buckets = new Map<string, Bucket>();

  for (const record of records) {
    const key = periodKey(record.date, granularity);
    const signed = signedAmount(record, flow);
    const existing = buckets.get(key);

    if (existing) {
      existing.total += signed;
      existing.count += 1;
    } else {
      buckets.set(key, {
        key,
        label: labelFor(record.date, granularity, locale),
        total: signed,
        count: 1,
      });
    }
  }

  return Array.from(buckets.values()).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/**
 * One period of the +/- view: deposits and withdrawals as separate totals.
 *
 * Unlike `Bucket`, which carries one signed total, this keeps both directions
 * apart so the chart can draw deposits above the axis and withdrawals below it.
 * `net` is their difference, for the hero and the tooltip summary.
 */
export interface DirectionBucket {
  key: string;
  label: string;
  /** Sum of deposits in this period; always >= 0. */
  depositsTotal: number;
  /** Sum of withdrawals in this period; always >= 0. */
  withdrawalsTotal: number;
  /** depositsTotal - withdrawalsTotal. */
  net: number;
  /** Total number of transactions (deposits + withdrawals). */
  count: number;
}

/**
 * Groups records into buckets for the +/- view.
 *
 * Every record contributes to its direction's total: deposits add to
 * `depositsTotal`, withdrawals to `withdrawalsTotal`. The two are never
 * netted inside a bucket, because the whole point of the view is to show them
 * as separate bars. `net` is their difference, for the hero and tooltip.
 */
export function bucketizeSplit(
  records: ContributionRecord[],
  granularity: Granularity,
  locale = 'en',
): DirectionBucket[] {
  const buckets = new Map<string, DirectionBucket>();

  for (const record of records) {
    const key = periodKey(record.date, granularity);
    const existing = buckets.get(key);

    if (existing) {
      if (record.flow === 'withdrawals') {
        existing.withdrawalsTotal += record.amount;
      } else {
        existing.depositsTotal += record.amount;
      }
      existing.net = existing.depositsTotal - existing.withdrawalsTotal;
      existing.count += 1;
    } else {
      const isWithdrawal = record.flow === 'withdrawals';
      buckets.set(key, {
        key,
        label: labelFor(record.date, granularity, locale),
        depositsTotal: isWithdrawal ? 0 : record.amount,
        withdrawalsTotal: isWithdrawal ? record.amount : 0,
        net: isWithdrawal ? -record.amount : record.amount,
        count: 1,
      });
    }
  }

  return Array.from(buckets.values()).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/**
 * Inserts empty buckets for periods between the first and last one.
 *
 * Without this a month with no contributions disappears from the axis and the
 * remaining bars sit at the wrong horizontal positions, so the spacing no longer
 * reflects time.
 *
 * `maxBuckets` guards against exploding the series: a day-level view over a year
 * would otherwise render 365 empty columns.
 */
export interface Period {
  key: string;
  label: string;
}

/**
 * Every period between the first and last key, inclusive.
 *
 * Shared by the total and the per-account view so both lay the bars out on the
 * same axis. `maxBuckets` keeps the most recent periods when the span is too
 * dense to plot: a day-level view over a year would otherwise emit 365 columns.
 */
export function buildPeriodAxis(
  firstKey: string,
  lastKey: string,
  granularity: Granularity,
  locale = 'en',
  maxBuckets = 400,
): Period[] {
  const first = parseKey(firstKey, granularity);
  const last = parseKey(lastKey, granularity);
  if (!first || !last) return [];

  const periods: Period[] = [];

  if (granularity === 'year') {
    for (let year = first.getFullYear(); year <= last.getFullYear(); year += 1) {
      periods.push({ key: String(year), label: String(year) });
    }
  } else {
    const cursor = new Date(first.getTime());
    while (cursor.getTime() <= last.getTime()) {
      periods.push({
        key: formatKey(cursor, granularity),
        label: labelFor(cursor, granularity, locale),
      });
      if (granularity === 'day') cursor.setDate(cursor.getDate() + 1);
      else cursor.setMonth(cursor.getMonth() + 1);
    }
  }

  return periods.length > maxBuckets ? periods.slice(-maxBuckets) : periods;
}

/**
 * Inserts empty buckets for periods between the first and last one.
 *
 * Without this a month with no contributions disappears from the axis and the
 * remaining bars sit at the wrong horizontal positions, so the spacing no longer
 * reflects time.
 */
export function fillGaps(
  buckets: Bucket[],
  granularity: Granularity,
  locale = 'en',
  maxBuckets = 400,
): Bucket[] {
  if (buckets.length < 2) return buckets;

  const byKey = new Map(buckets.map((bucket) => [bucket.key, bucket]));
  const axis = buildPeriodAxis(
    buckets[0].key,
    buckets[buckets.length - 1].key,
    granularity,
    locale,
    maxBuckets,
  );

  return axis.map((period) => byKey.get(period.key) ?? { ...period, total: 0, count: 0 });
}

function parseKey(key: string, granularity: Granularity): Date | undefined {
  const parts = key.split('-').map((part) => Number.parseInt(part, 10));
  if (parts.some((part) => Number.isNaN(part))) return undefined;

  if (granularity === 'year') return new Date(parts[0], 0, 1);
  if (granularity === 'month') return new Date(parts[0], parts[1] - 1, 1);
  return new Date(parts[0], parts[1] - 1, parts[2]);
}

function formatKey(date: Date, granularity: 'month' | 'day'): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return granularity === 'day' ? `${date.getFullYear()}-${month}-${day}` : `${date.getFullYear()}-${month}`;
}

function labelFor(date: Date, granularity: Granularity, locale: string): string {
  if (granularity === 'year') return String(date.getFullYear());
  if (granularity === 'month') return formatMonthLabel(date, locale);
  return formatKey(date, 'day');
}
/* ------------------------------------------------------------ per account */

/**
 * Bucket id used when an activity carries no account.
 *
 * Rows without an account collapse into one series rather than producing a stack
 * of nameless slices, and a record reaching this module with no account at all
 * cannot produce a series literally named "undefined".
 */
export const UNKNOWN_ACCOUNT = 'unknown-account';

export interface AccountRef {
  id: string;
  name: string;
}

export interface SplitBucket {
  key: string;
  label: string;
  /** Amount per account id; every account is present, defaulting to 0. */
  values: Record<string, number>;
  /** Sum across accounts, for axis scaling. */
  total: number;
}

export interface SplitResult {
  /** Stable ordering: largest contributor first, then by name. */
  accounts: AccountRef[];
  buckets: SplitBucket[];
}

/**
 * Groups records by period and account.
 *
 * Every period on the axis carries a value for every account, including zeros, so
 * a stacked chart keeps a stable segment order and never leaves a hole where an
 * account had no deposits.
 */
export function bucketizeByAccount(
  records: ContributionRecord[],
  granularity: Granularity,
  locale = 'en',
  flow: Flow = 'deposits',
  maxBuckets = 400,
): SplitResult {
  if (records.length === 0) return { accounts: [], buckets: [] };

  const accountMeta = new Map<string, { name: string; total: number }>();
  const cells = new Map<string, Map<string, number>>();
  const keys: string[] = [];
  const seen = new Set<string>();

  for (const record of records) {
    const key = periodKey(record.date, granularity);
    const signed = signedAmount(record, flow);
    const accountId =
      typeof record.accountId === 'string' && record.accountId
        ? record.accountId
        : UNKNOWN_ACCOUNT;
    const accountName =
      typeof record.accountName === 'string' && record.accountName.trim()
        ? record.accountName.trim()
        : accountId;

    if (!seen.has(key)) {
      seen.add(key);
      keys.push(key);
    }

    const meta = accountMeta.get(accountId);
    if (meta) {
      meta.total += signed;
      // A later activity may carry the account name where an earlier one did not.
      if (meta.name === accountId && accountName !== accountId) {
        meta.name = accountName;
      }
    } else {
      accountMeta.set(accountId, { name: accountName, total: signed });
    }

    let row = cells.get(key);
    if (!row) {
      row = new Map<string, number>();
      cells.set(key, row);
    }
    row.set(accountId, (row.get(accountId) ?? 0) + signed);
  }

  keys.sort();

  const accounts: AccountRef[] = Array.from(accountMeta.entries())
    .map(([id, meta]) => ({ id, name: meta.name }))
    .sort((a, b) => {
      const delta = accountMeta.get(b.id)!.total - accountMeta.get(a.id)!.total;
      return delta !== 0 ? delta : a.name.localeCompare(b.name);
    });

  const axis = buildPeriodAxis(keys[0], keys[keys.length - 1], granularity, locale, maxBuckets);

  const buckets: SplitBucket[] = axis.map((period) => {
    const row = cells.get(period.key);
    const values: Record<string, number> = {};
    let total = 0;
    for (const account of accounts) {
      const value = row?.get(account.id) ?? 0;
      values[account.id] = value;
      total += value;
    }
    return { key: period.key, label: period.label, values, total };
  });

  return { accounts, buckets };
}

/**
 * One period of the per-account +/- view.
 *
 * Two independent maps rather than one: deposits and withdrawals are never
 * netted inside an account, because each one is its own stacked series in a
 * separate column. `net` is their difference across all accounts, for the hero.
 */
export interface DirectionSplitBucket {
  key: string;
  label: string;
  /** Deposits per account id; every account is present, defaulting to 0. */
  deposits: Record<string, number>;
  /** Withdrawals per account id; unsigned, the caller negates for the chart. */
  withdrawals: Record<string, number>;
  /** Total deposits minus total withdrawals across every account. */
  net: number;
  /** Total transactions in the period, both directions. */
  count: number;
}

export interface DirectionSplitResult {
  /** Stable ordering: largest contributor first, then by name. */
  accounts: AccountRef[];
  buckets: DirectionSplitBucket[];
}

/**
 * Groups records by period, account **and** direction.
 *
 * This is what the per-account +/- view stacks. `bucketizeByAccount` cannot be
 * used for it even by calling it twice: it signs its values by flow, so a
 * second call would overwrite the first rather than adding a second column,
 * and it returns one value per account where this needs two.
 *
 * Every period on the axis carries a value for every account in both maps,
 * zeros included, so each stack keeps a stable segment order.
 */
export function bucketizeByDirection(
  records: ContributionRecord[],
  granularity: Granularity,
  locale = 'en',
  maxBuckets = 400,
): DirectionSplitResult {
  if (records.length === 0) return { accounts: [], buckets: [] };

  const accountMeta = new Map<string, { name: string; total: number }>();
  const cells = new Map<string, { deposits: Map<string, number>; withdrawals: Map<string, number>; count: number }>();
  const keys: string[] = [];
  const seen = new Set<string>();

  for (const record of records) {
    const key = periodKey(record.date, granularity);
    const isWithdrawal = record.flow === 'withdrawals';
    const accountId =
      typeof record.accountId === 'string' && record.accountId
        ? record.accountId
        : UNKNOWN_ACCOUNT;
    const accountName =
      typeof record.accountName === 'string' && record.accountName.trim()
        ? record.accountName.trim()
        : accountId;

    if (!seen.has(key)) {
      seen.add(key);
      keys.push(key);
    }

    const meta = accountMeta.get(accountId);
    if (meta) {
      // Ranked by absolute volume: a dominant withdrawal account still leads.
      meta.total += isWithdrawal ? -record.amount : record.amount;
      // A later activity may carry the account name an earlier one lacked.
      if (meta.name === accountId && accountName !== accountId) {
        meta.name = accountName;
      }
    } else {
      accountMeta.set(accountId, {
        name: accountName,
        total: isWithdrawal ? -record.amount : record.amount,
      });
    }

    let row = cells.get(key);
    if (!row) {
      row = { deposits: new Map(), withdrawals: new Map(), count: 0 };
      cells.set(key, row);
    }
    const side = isWithdrawal ? row.withdrawals : row.deposits;
    side.set(accountId, (side.get(accountId) ?? 0) + record.amount);
    row.count += 1;
  }

  keys.sort();

  const accounts: AccountRef[] = Array.from(accountMeta.entries())
    .map(([id, meta]) => ({ id, name: meta.name }))
    .sort((a, b) => {
      const delta = accountMeta.get(b.id)!.total - accountMeta.get(a.id)!.total;
      return delta !== 0 ? delta : a.name.localeCompare(b.name);
    });

  const axis = buildPeriodAxis(keys[0], keys[keys.length - 1], granularity, locale, maxBuckets);

  const buckets: DirectionSplitBucket[] = axis.map((period) => {
    const row = cells.get(period.key);
    const deposits: Record<string, number> = {};
    const withdrawals: Record<string, number> = {};
    let net = 0;
    for (const account of accounts) {
      const d = row?.deposits.get(account.id) ?? 0;
      const w = row?.withdrawals.get(account.id) ?? 0;
      deposits[account.id] = d;
      withdrawals[account.id] = w;
      net += d - w;
    }
    return {
      key: period.key,
      label: period.label,
      deposits,
      withdrawals,
      net,
      count: row?.count ?? 0,
    };
  });

  return { accounts, buckets };
}

/** What a drill-down panel is showing. */
export interface DrillDownSelection {
  /** Period key the panel belongs to, at the current granularity. */
  periodKey: string;
  /** Account to restrict to; every account when omitted (the total view). */
  accountId?: string;
}

/** Series key prefixes used by the stacked +/- view. `d` deposits, `w` withdrawals. */
const DIRECTION_SERIES_PREFIX = /^[dw](\d+)$/;

/**
 * Resolves the account behind a per-account series key.
 *
 * The stacked chart identifies accounts positionally because the key has to be
 * short and CSS-safe, so the series key is not the account id and the drill-down
 * cannot filter on it directly. Three shapes exist: `s0`, `s1`, … (per-account
 * stack) and `d0`, `w0`, `d1`, `w1`, … (the +/- view, one pair per account,
 * `d` deposits and `w` withdrawals). All of them resolve the same way — the
 * index is the account, whichever letter qualified it.
 *
 * Returns `undefined` for an out-of-range key rather than `undefined` for the
 * id: a caller that treats "no account id" as "the whole period" would list
 * every account under this segment's name.
 */
export function resolveAccountFromSeriesKey(
  accounts: AccountRef[],
  dataKey: string,
): AccountRef | undefined {
  const match = /^s(\d+)$/.exec(dataKey) ?? DIRECTION_SERIES_PREFIX.exec(dataKey);
  if (!match) return undefined;
  const index = Number.parseInt(match[1], 10);
  if (!Number.isInteger(index) || index < 0) return undefined;
  return accounts[index];
}

/**
 * Direction a per-account +/- series key belongs to.
 *
 * `deposits` and `withdrawals` are the two stacks; `undefined` for anything
 * else, which is how the caller tells a +/- series from a plain per-account one
 * without the chart having to know which view it is rendering.
 */
export function directionOfSeriesKey(dataKey: string): 'deposits' | 'withdrawals' | undefined {
  if (dataKey.startsWith('d')) return 'deposits';
  if (dataKey.startsWith('w')) return 'withdrawals';
  return undefined;
}

/** What the chart reports when a bar (or a tooltip row) is activated. */
export interface BarClickSelection {
  periodKey: string;
  periodLabel: string;
  /** The series that was clicked, e.g. `s0` or `total`. */
  dataKey: string;
  value: number;
}

/**
 * Turns a bar click into the drill-down it stands for.
 *
 * The chart cannot decide this on its own: it is handed series keys, not
 * accounts, and it has no way to tell an account key from the total key. It used
 * to guess by comparing the key against the literal `total`, which is a rename
 * away from silently filtering on an account id that does not exist — every
 * click opening an empty panel.
 *
 * So the caller states which view it is in: `accounts` is empty in the total
 * view, which makes "no account" the answer rather than a guess. `undefined` is
 * returned for a key that resolves to nothing, because a caller treating that as
 * "the whole period" would list every account under this segment's name.
 */
export function barClickToDrillDown(
  click: BarClickSelection,
  accounts: AccountRef[],
): DrillDownSelection | undefined {
  const selection: DrillDownSelection = { periodKey: click.periodKey };

  if (accounts.length > 0) {
    const account = resolveAccountFromSeriesKey(accounts, click.dataKey);
    if (!account) return undefined;
    selection.accountId = account.id;
  }

  return selection;
}

/**
 * The deposits or withdrawals behind one bar of the chart, per the view flow.
 *
 * The selector owns the interval window rather than receiving an already-scoped
 * list. Bucket keys are only as narrow as the granularity, so on a partially
 * covered period — a `2025` bar under a one-year window that starts in October
 * covers Oct-Dec only — a panel fed the unfiltered records would report the whole
 * year and disagree with the bar, with `BarClickInfo.value` and with Total
 * contributed.
 *
 * Taking the window as an argument rather than a pre-filtered list is what makes
 * that mistake unexpressible. The scoping then lives in one place the tests
 * cover. With a pre-filtered list the selector was never wrong on its own — only
 * what it was handed — so reintroducing the bug left `npm test` green.
 */
export function selectDrillDownRecords(
  records: ContributionRecord[],
  window: DateWindow,
  selection: DrillDownSelection,
  granularity: Granularity,
  flow: Flow = 'deposits',
): ContributionRecord[] {
  return filterByRange(records, window).filter((record) => {
    if (periodKey(record.date, granularity) !== selection.periodKey) return false;
    if (selection.accountId && record.accountId !== selection.accountId) return false;
    // The net and split views list both directions; the single-flow views list only theirs.
    if (flow !== 'net' && flow !== 'split' && record.flow !== flow) return false;
    return true;
  });
}

export function formatMonthLabel(date: Date, locale = 'en'): string {
  try {
    return new Intl.DateTimeFormat(locale, {
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(new Date(Date.UTC(date.getFullYear(), date.getMonth(), 1)));
  } catch {
    return `${MONTHS_SHORT[date.getMonth()]} ${date.getFullYear()}`;
  }
}

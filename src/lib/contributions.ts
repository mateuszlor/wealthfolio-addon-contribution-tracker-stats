/**
 * Pure, dependency-free aggregation of contribution (deposit) records.
 *
 * Kept free of React and of the Wealthfolio SDK so it can be unit tested and
 * reasoned about on its own.
 */

export type Granularity = 'month' | 'day' | 'year';

export interface ContributionRecord {
  /** Moment the contribution was recorded. */
  date: Date;
  /** Positive contribution amount, in the base currency. */
  amount: number;
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

export function summarize(records: ContributionRecord[]): Summary {
  if (records.length === 0) {
    return { total: 0, count: 0, average: 0, monthlyAverage: 0 };
  }

  let total = 0;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;

  for (const record of records) {
    total += record.amount;
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

/** Groups records into chronological buckets of the requested granularity. */
export function bucketize(
  records: ContributionRecord[],
  granularity: Granularity,
  locale = 'en',
): Bucket[] {
  const buckets = new Map<string, Bucket>();

  for (const record of records) {
    const { date, amount } = record;
    const year = date.getFullYear();
    const month = pad(date.getMonth() + 1);
    const day = pad(date.getDate());

    let key: string;
    let label: string;

    switch (granularity) {
      case 'year':
        key = `${year}`;
        label = `${year}`;
        break;
      case 'day':
        key = `${year}-${month}-${day}`;
        label = key;
        break;
      case 'month':
      default:
        key = `${year}-${month}`;
        label = formatMonthLabel(date, locale);
        break;
    }

    const existing = buckets.get(key);
    if (existing) {
      existing.total += amount;
      existing.count += 1;
    } else {
      buckets.set(key, { key, label, total: amount, count: 1 });
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
export function fillGaps(
  buckets: Bucket[],
  granularity: Granularity,
  locale = 'en',
  maxBuckets = 400,
): Bucket[] {
  if (buckets.length < 2) return buckets;

  const byKey = new Map(buckets.map((bucket) => [bucket.key, bucket]));
  const first = parseKey(buckets[0].key, granularity);
  const last = parseKey(buckets[buckets.length - 1].key, granularity);
  if (!first || !last) return buckets;

  const filled: Bucket[] = [];

  if (granularity === 'year') {
    for (let year = first.getFullYear(); year <= last.getFullYear(); year += 1) {
      const key = String(year);
      filled.push(byKey.get(key) ?? { key, label: key, total: 0, count: 0 });
    }
  } else {
    const cursor = new Date(first.getTime());
    while (cursor.getTime() <= last.getTime()) {
      const key = formatKey(cursor, granularity);
      filled.push(
        byKey.get(key) ?? { key, label: labelFor(cursor, granularity, locale), total: 0, count: 0 },
      );
      if (granularity === 'day') cursor.setDate(cursor.getDate() + 1);
      else cursor.setMonth(cursor.getMonth() + 1);
    }
  }

  // Keep the most recent periods when the span is too dense to plot.
  return filled.length > maxBuckets ? filled.slice(-maxBuckets) : filled;
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

function labelFor(date: Date, granularity: 'month' | 'day', locale: string): string {
  return granularity === 'month' ? formatMonthLabel(date, locale) : formatKey(date, 'day');
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

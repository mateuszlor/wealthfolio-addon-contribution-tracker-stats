/**
 * Pure intake logic: turns raw host activities into contribution records.
 *
 * Kept free of React and of the SDK so it can be regression tested directly.
 */

import { toAmount, toDate, UNKNOWN_ACCOUNT, type ContributionRecord } from './contributions';

export const DEPOSIT = 'DEPOSIT';

export interface IntakeStats {
  /** Rows returned by the host. */
  fetched: number;
  /** Rows that were deposits. */
  deposits: number;
  /** Deposits dropped because the date field was missing or unparseable. */
  skippedNoDate: number;
  /** Deposits dropped because the amount was zero. */
  skippedZeroAmount: number;
  /** activityType -> count, so a wrong filter is obvious in the log. */
  byType: Record<string, number>;
}

/**
 * Minimal shape we rely on. `ctx.api.activities.getAll()` resolves
 * `ActivityDetails`, which uses `date` and `assetSymbol`; the `Activity` shape
 * uses `activityDate` and `symbol`. Both are accepted so the addon keeps working
 * if the host returns either one.
 */
export interface RawActivity {
  id?: string | null;
  activityType?: string | null;
  activityTypeOverride?: string | null;
  date?: Date | string | null;
  activityDate?: string | Date | null;
  amount?: string | number | null;
  currency?: string | null;
  assetSymbol?: string | null;
  symbol?: string | null;
  accountId?: string | null;
  accountName?: string | null;
}

/** Bucket id used when the host does not name an account on the activity. */
export { UNKNOWN_ACCOUNT };

export interface Intake {
  records: ContributionRecord[];
  stats: IntakeStats;
}

export function emptyIntakeStats(): IntakeStats {
  return { fetched: 0, deposits: 0, skippedNoDate: 0, skippedZeroAmount: 0, byType: {} };
}

export function isDeposit(activity: RawActivity): boolean {
  const type = activity.activityTypeOverride ?? activity.activityType;
  return typeof type === 'string' && type.toUpperCase() === DEPOSIT;
}

/**
 * Currency the amount is denominated in.
 *
 * `ActivityDetails` carries `currency` directly; the legacy `Activity` shape
 * only marks cash rows with a `$CASH-<ISO>` symbol. When neither is present the
 * record falls back to the addon's base currency rather than being dropped — a
 * missing label must not cost a deposit, but it has to be visible somewhere,
 * which the per-currency selector on the page is.
 */
export const FALLBACK_CURRENCY = 'PLN';

export function readCurrency(activity: RawActivity): string {
  const direct =
    typeof activity.currency === 'string' ? activity.currency.trim().toUpperCase() : '';
  if (direct) return direct;

  const symbol = activity.assetSymbol ?? activity.symbol;
  if (typeof symbol === 'string') {
    const match = /^\$CASH-([A-Z]{3})$/i.exec(symbol.trim());
    if (match) return match[1].toUpperCase();
  }

  return FALLBACK_CURRENCY;
}

/** `ActivityDetails.date` first, `Activity.activityDate` as the fallback. */
export function readDate(activity: RawActivity): Date | undefined {
  return toDate(activity.date ?? activity.activityDate);
}

/**
 * Resolves the account a deposit belongs to.
 *
 * `ActivityDetails` carries `accountId` / `accountName`. Older rows and some
 * import shapes omit them, so everything unidentifiable collapses into one
 * bucket rather than producing a stack of nameless slices.
 */
export function readAccount(activity: RawActivity): { id: string; name: string } {
  const id = typeof activity.accountId === 'string' && activity.accountId
    ? activity.accountId
    : UNKNOWN_ACCOUNT;

  const name = typeof activity.accountName === 'string' && activity.accountName.trim()
    ? activity.accountName.trim()
    : id;

  return { id, name };
}

/**
 * Converts raw activities into sorted contribution records, collecting intake
 * diagnostics so an unexpectedly empty chart is explainable from the log.
 */
export function toContributionRecords(activities: unknown): Intake {
  const stats = emptyIntakeStats();

  if (!Array.isArray(activities)) return { records: [], stats };

  const records: ContributionRecord[] = [];

  for (const activity of activities as RawActivity[]) {
    if (!activity) continue;

    const rawType = activity.activityTypeOverride ?? activity.activityType;
    const type = typeof rawType === 'string' ? rawType : 'UNKNOWN';
    stats.fetched += 1;
    stats.byType[type] = (stats.byType[type] ?? 0) + 1;

    if (!isDeposit(activity)) continue;
    stats.deposits += 1;

    const date = readDate(activity);
    if (!date) {
      stats.skippedNoDate += 1;
      continue;
    }

    const amount = Math.abs(toAmount(activity.amount));
    if (amount === 0) {
      stats.skippedZeroAmount += 1;
      continue;
    }

    const account = readAccount(activity);
    records.push({
      date,
      amount,
      currency: readCurrency(activity),
      accountId: account.id,
      accountName: account.name,
      activityId: typeof activity.id === 'string' ? activity.id : '',
    });
  }

  records.sort((a, b) => a.date.getTime() - b.date.getTime());
  return { records, stats };
}

/** Single-line diagnostic used in the addon log. */
export function formatIntakeLog(stats: IntakeStats, kept: number): string {
  return (
    `fetched=${stats.fetched} deposits=${stats.deposits} kept=${kept} ` +
    `skippedNoDate=${stats.skippedNoDate} skippedZeroAmount=${stats.skippedZeroAmount} ` +
    `types=${JSON.stringify(stats.byType)}`
  );
}

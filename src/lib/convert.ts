/**
 * Currency conversion to the host's base currency.
 *
 * Everything here is pure: the bridge call lives in `useConvertedRecords`
 * (src/hooks/useConvertedRecords.ts), which fetches the rates and hands this
 * module plain `ConvertRecord` rows to reduce. Keeping the maths here is what
 * makes the rates table testable without the SDK.
 *
 * The conversion uses **historical** rates — one per record, taken at the
 * record's own date — because a running total that mixes 2023 contributions
 * converted with today's rates with 2026 ones is not a contribution ledger any
 * more. The host resolves this the same way for the `invested` figure
 * (`activities.calculateDeposits` uses per-activity rates), and
 * `exchangeRates.getRatesForDates` applies Wealthfolio's core FX rules:
 * currency normalisation, inverse/triangulated paths, nearest available
 * quotes, and a latest-rate fallback before giving up on a pair.
 */

import type { ContributionRecord } from './contributions';
import { signedAmount, type Flow } from './contributions';

/** One (pair, date) request as the SDK defines it. */
export interface RateQuery {
  fromCurrency: string;
  toCurrency: string;
  date: string;
}

/** One result per requested pair, in the same order — an SDK shape. */
export interface RateResult {
  fromCurrency: string;
  toCurrency: string;
  date: string;
  rate: number | null;
  error: string | null;
}

/** `YYYY-MM-DD` in local time, matching how `intake` reads activity dates. */
export function toDayKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * Minimal rate plan for a record set: distinct (currency, day) pairs needing
 * conversion to the base, i.e. every non-base currency in the records itself.
 *
 * Deduplicated and sorted, so the same records produce one bridge call no
 * matter how they are ordered, and a memo on the plan keeps repeated renders
 * from refetching rates.
 */
export function planRateQueries(
  records: ContributionRecord[],
  baseCurrency: string,
): RateQuery[] {
  const base = baseCurrencyNormalised(baseCurrency);
  const pairs = new Set<string>();

  for (const record of records) {
    const from = record.currency.trim().toUpperCase();
    if (!from) continue;
    if (from === base) continue; // nothing to convert

    pairs.add(`${from}|${base}|${toDayKey(record.date)}`);
  }

  return Array.from(pairs).sort().map((pair) => {
    const [fromCurrency, toCurrency, date] = pair.split('|');
    return { fromCurrency, toCurrency, date };
  });
}

function baseCurrencyNormalised(baseCurrency: string): string {
  return baseCurrency.trim().toUpperCase();
}

/**
 * Builds the `from|to|date` -> rate table from the host's answer.
 *
 * Results are keyed by **the pair and date the result itself names**, never by
 * its position in the array. `getRatesForDates` documents that it resolves
 * "one result per requested pair, in the same order", so positional pairing is
 * what the contract describes — but the result carries `fromCurrency`,
 * `toCurrency` and `date` precisely so it can be matched on its own, and a
 * silent mismatch here is the worst failure this module has: a 2023 deposit
 * priced with the 2026 rate reads as a plausible number, not as a bug. Keying
 * by identity costs nothing and cannot mis-price a record.
 *
 * A result naming a pair or date nobody asked for is **ignored**, and a result
 * with no usable rate (`null`, `error`, non-finite, non-positive) leaves its
 * key absent, so `convertRecords` drops that record rather than guessing.
 *
 * Note the one case this cannot resolve on its own: if the host resolves a
 * missing day to a *nearest available quote* and echoes that quote's date
 * instead of the requested one, the key will not match and the record is
 * dropped. That failure is deliberate and visible — `dropped` grows and the
 * page says so — where applying the wrong day's rate would be invisible. Which
 * of the two the host actually does is a host measurement, not a guess.
 */
export function rateTableFromResults(
  queries: RateQuery[],
  results: RateResult[],
): Map<string, number> {
  const table = new Map<string, number>();
  // Only pairs that were actually requested may enter the table, so a stray or
  // padded result cannot introduce a key nothing will ever look up.
  const requested = new Set(
    queries.map((query) =>
      rateKey(
        baseCurrencyNormalised(query.fromCurrency),
        baseCurrencyNormalised(query.toCurrency),
        query.date,
      ),
    ),
  );

  for (const result of results ?? []) {
    if (!result) continue;

    const key = rateKey(
      baseCurrencyNormalised(result.fromCurrency ?? ''),
      baseCurrencyNormalised(result.toCurrency ?? ''),
      result.date,
    );
    if (!requested.has(key)) continue;

    const { rate } = result;
    if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) continue;

    table.set(key, rate);
  }

  return table;
}

function rateKey(
  from: string,
  to: string,
  date: string,
): string {
  return `${from}|${to}|${date}`;
}

/**
 * Converts record amounts to the base currency, in place, using the rates table.
 *
 * Records already in the base pass through untouched (identity), and a record
 * whose (pair, day) has no rate in the table is **dropped, not zeroed** — same
 * policy as `intake` for undatable rows: a believed-wrong number is worse than
 * a missing one, and the hook reports how many were dropped so an empty-looking
 * chart is explainable.
 */
export interface ConvertOutcome {
  records: ContributionRecord[];
  /** Rows dropped because their (pair, day) had no resolvable rate. */
  dropped: number;
}

export function convertRecords(
  records: ContributionRecord[],
  baseCurrency: string,
  rates: Map<string, number>,
): ConvertOutcome {
  const base = baseCurrencyNormalised(baseCurrency);
  const kept: ContributionRecord[] = [];
  let dropped = 0;

  for (const record of records) {
    const from = record.currency.trim().toUpperCase();

    if (from === base) {
      kept.push(record);
      continue;
    }

    const rate = rates.get(rateKey(from, base, toDayKey(record.date)));
    if (rate === undefined) {
      dropped += 1;
      continue;
    }

    kept.push({ ...record, amount: record.amount * rate, currency: base });
  }

  return { records: kept, dropped };
}

/**
 * All-flow view helper: signed total of every record under one flow, in base
 * currency — used for the auto currency pick and for the hero when the
 * conversion view is on.
 */
export function signedTotal(
  records: ContributionRecord[],
  flow: Flow,
): number {
  return records.reduce((sum, record) => sum + signedAmount(record, flow), 0);
}

import { useEffect, useMemo, useRef, useState } from 'react';
import type { AddonContext } from '@wealthfolio/addon-sdk';
import type { ContributionRecord } from '../lib/contributions';
import {
  convertRecords,
  planRateQueries,
  rateTableFromResults,
  type RateResult,
} from '../lib/convert';

/**
 * Settings key of the host's base currency, exposed by `ctx.api.settings.get()`
 * (`Settings.baseCurrency`, SDK ≥ 3.9). Read once and re-read if the identity
 * of `ctx` changes; the host really only writes it from its own settings page,
 * so a one-shot read is enough here.
 */
interface BaseSettings {
  baseCurrency?: string;
}

/**
 * Bridge: fetch historical rates for one record set and hand back records in
 * the base currency.
 *
 * Returns the converted list plus `dropped` — the count the bridge could not
 * resolve — so the page can surface that number the way `intake` surfaces
 * `skippedNoDate` today. The **identity** of `records` drives the memo: the
 * page builds `records` in a `useMemo` upstream (intake output), and feeding
 * a fresh array per render would refetch rates on every frame.
 */
export interface ConvertedRecordsState {
  records: ContributionRecord[] | undefined;
  dropped: number;
  baseCurrency?: string;
  /**
   * Why the conversion view is or is not available.
   *
   * This exists because the view failed on a real host with **no symptom at
   * all**: `ALL (PLN)` was selectable, the page rendered `PLN 0.00` with zero
   * contributions, and nothing in the console said why. The base-currency read
   * and the rate fetch both swallow their failures into an empty comment, which
   * is exactly how a broken bridge becomes an indistinguishable "you have no
   * contributions". Naming the reason lets the page explain itself and lets a
   * host test assert on it instead of inferring from a zero.
   */
  status: ConvertStatus;
}

export type ConvertStatus =
  | 'loading' // nothing has answered yet
  | 'no-settings-bridge' // ctx.api.settings missing or has no get()
  | 'settings-rejected' // the bridge threw or rejected
  | 'no-base-currency' // the settings payload carried no baseCurrency
  | 'no-rate-bridge' // ctx.api.exchangeRates missing, or no getRatesForDates
  | 'rates-rejected' // the rate fetch threw or rejected
  | 'ready'; // converted records available

/**
 * Reports a conversion failure to the host log.
 *
 * Failures here used to vanish into comments. `ctx.api.logger` is a baseline
 * capability, so this needs no permission, and `addon.tsx` already forwards
 * runtime errors the same way — a host that shows a blank feature should at
 * least say which bridge answered.
 */
function report(ctx: AddonContext, status: ConvertStatus, detail?: unknown): void {
  try {
    ctx?.api?.logger?.warn?.(`[convert] ${status}${detail ? ` — ${String(detail)}` : ''}`);
  } catch {
    // Logging must never become the failure.
  }
}

export function useConvertedRecords(
  ctx: AddonContext,
  records: ContributionRecord[],
): ConvertedRecordsState {
  const [currency, setCurrency] = useState<string | undefined>(undefined);
  const [out, setOut] = useState<ConvertedRecordsState>({
    records: undefined,
    dropped: 0,
    status: 'loading',
  });

  // One settings read: the base currency only changes from the host page,
  // which would remount us anyway (same lifecycle as useAccountScope).
  useEffect(() => {
    let cancelled = false;
    const settings = ctx?.api?.settings;
    if (!settings || typeof settings.get !== 'function') {
      report(ctx, 'no-settings-bridge', `typeof ctx.api.settings = ${typeof settings}`);
      if (!cancelled) setOut({ records: undefined, dropped: 0, status: 'no-settings-bridge' });
      return;
    }

    settings
      .get()
      .then((value: BaseSettings) => {
        // The bridge may hand back the settings object itself or something
        // wrapping it, so the payload is probed rather than assumed.
        const base = value?.baseCurrency;
        if (!cancelled && !base) {
          report(
            ctx,
            'no-base-currency',
            `payload keys = ${JSON.stringify(Object.keys(value ?? {}))}`,
          );
          setOut({ records: undefined, dropped: 0, status: 'no-base-currency' });
          return;
        }
        if (!cancelled) setCurrency(base);
      })
      .catch((error: unknown) => {
        report(ctx, 'settings-rejected', error);
        if (!cancelled) setOut({ records: undefined, dropped: 0, status: 'settings-rejected' });
      });

    return () => {
      cancelled = true;
    };
  }, [ctx]);

  // The rate plan, memoised on the exact records array — the upstream page
  // memoises the list it hands us, so the same data keeps one plan.
  const plan = useMemo(
    () => (currency ? planRateQueries(records, currency) : []),
    [records, currency],
  );

  // Serialised by records identity; each plan fires one batched call.
  const sequences = useRef(0);
  useEffect(() => {
    if (!currency || plan.length === 0) {
      // Nothing to convert (single currency already in base, or no records):
      // the conversion pass-through is synchronous and cheap.
      setOut({ records, dropped: 0, baseCurrency: currency, status: 'ready' });
      return;
    }

    // SDK surface is `api.exchangeRates`; the manifest permission category is
    // `currency` — validate.mjs maps bundle calls to categories by its own table.
    //
    // **Do not `.bind()` the bridge function.** `ctx.api.*` arrives in the
    // sandbox as a host-provided bridge whose method objects carry the sandbox
    // Window in their scope; `bind` on such a method produced
    // `DataCloneError: structuredClone on 'Window'` inside the host bridge
    // (a blank page, logged by the host as "runtime error: Uncaught "). The
    // plain call on the borrowed reference is what the other hooks
    // (`settings.get` in this file, `storage.get`, `activities.getAll`) use,
    // and the only shape that has ever worked on this host.
    const exchangeRates = ctx?.api?.exchangeRates;
    const exchangeApi = exchangeRates as unknown as
      | { getRatesForDates?: (pairs: unknown) => Promise<RateResult[]> }
      | undefined;
    const getRatesForDates = exchangeApi?.getRatesForDates;
    if (typeof getRatesForDates !== 'function') {
      // Permission missing / SDK too old: no conversion is possible, same
      // graceful exit as above — the page falls back to per-currency view.
      report(ctx, 'no-rate-bridge', `plan=${plan.length} pairs`);
      setOut({
        records: undefined,
        dropped: 0,
        baseCurrency: currency,
        status: 'no-rate-bridge',
      });
      return;
    }

    const seq = ++sequences.current;
    Promise.resolve()
      .then(() => getRatesForDates!.call(exchangeApi, plan))
      .then((results: RateResult[]) => {
        if (seq !== sequences.current) return; // superseded by newer input

        // The answer's shape decides whether conversion can work at all, and it
        // is the one thing that cannot be checked from a type: the host may
        // return fewer rows than asked, or a wrapper rather than a list.
        report(
          ctx,
          'ready',
          `asked=${plan.length} answered=${Array.isArray(results) ? results.length : 'not-a-list'} ` +
            `first=${JSON.stringify(Array.isArray(results) ? results[0] : results)}`,
        );

        const table = rateTableFromResults(plan, results);
        const outcome = convertRecords(records, currency, table);
        setOut({
          records: outcome.records,
          dropped: outcome.dropped,
          baseCurrency: currency,
          status: 'ready',
        });
      })
      .catch((error: unknown) => {
        // The bridge itself failed; same graceful exit.
        report(ctx, 'rates-rejected', error);
        if (seq === sequences.current) {
          setOut({
            records: undefined,
            dropped: 0,
            baseCurrency: currency,
            status: 'rates-rejected',
          });
        }
      });
  }, [ctx, records, currency, plan]);

  // While a fetch for a non-empty plan is in flight, `records` is `undefined`
  // and the caller must hold the previous view or a loader.
  return out;
}

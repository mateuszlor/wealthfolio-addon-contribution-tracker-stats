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
}

export function useConvertedRecords(
  ctx: AddonContext,
  records: ContributionRecord[],
): ConvertedRecordsState {
  const [currency, setCurrency] = useState<string | undefined>(undefined);
  const [out, setOut] = useState<ConvertedRecordsState>({
    records: undefined,
    dropped: 0,
  });

  // One settings read: the base currency only changes from the host page,
  // which would remount us anyway (same lifecycle as useAccountScope).
  useEffect(() => {
    let cancelled = false;
    const settings = ctx?.api?.settings;
    if (!settings || typeof settings.get !== 'function') return;

    settings
      .get()
      .then((value: BaseSettings) => {
        if (!cancelled) setCurrency(value?.baseCurrency);
      })
      .catch(() => {
        // Without the base currency the conversion view cannot be built;
        // the page keeps showing the per-currency selector.
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
      setOut({ records, dropped: 0, baseCurrency: currency });
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
      setOut({ records: undefined, dropped: 0, baseCurrency: currency });
      return;
    }

    const seq = ++sequences.current;
    Promise.resolve()
      .then(() => getRatesForDates!.call(exchangeApi, plan))
      .then((results: RateResult[]) => {
        if (seq !== sequences.current) return; // superseded by newer input

        const table = rateTableFromResults(plan, results);
        const outcome = convertRecords(records, currency, table);
        setOut({ records: outcome.records, dropped: outcome.dropped, baseCurrency: currency });
      })
      .catch(() => {
        // The bridge itself failed; same graceful exit.
        if (seq === sequences.current) {
          setOut({ records: undefined, dropped: 0, baseCurrency: currency });
        }
      });
  }, [ctx, records, currency, plan]);

  // While a fetch for a non-empty plan is in flight, `records` is `undefined`
  // and the caller must hold the previous view or a loader.
  return out;
}

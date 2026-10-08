import { useCallback, useEffect, useState } from 'react';
import type { AddonContext } from '@wealthfolio/addon-sdk';

/**
 * `storage` keys are capped at 128 characters from `[A-Za-z0-9_.:-]`, and the
 * namespace keeps the addon prefix like `STORAGE_KEY` in the page component.
 */
const STORAGE_KEY = 'contribution-tracker-stats.hideAmounts';

/**
 * Add-on-local "hide the amounts" flag, persisted through the host storage bridge.
 *
 * `localStorage` is deliberately not used: the add-on runs in an iframe created
 * with `sandbox="allow-scripts"` and therefore has an opaque origin, where
 * `localStorage.getItem` throws and `setItem` throws a `SecurityError` on every
 * write — which the host classifies into its "this add-on uses browser storage"
 * toast. `ctx.api.storage` is the documented replacement and is a baseline
 * category, so it needs no permission in `manifest.json`.
 *
 * Because the host exposes no privacy bridge to add-ons, this flag is *not*
 * shared with Wealthfolio's own privacy setting — see README, "Privacy".
 */
export interface HiddenAmountsState {
  /** True while the amounts are masked. */
  hidden: boolean;
  toggle: () => void;
}

export function useHiddenAmounts(ctx: AddonContext): HiddenAmountsState {
  // The stored value is only known after an async read, so the first render shows
  // the amounts; a reload therefore does not flash a masked total.
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const storage = ctx?.api?.storage;

    if (!storage || typeof storage.get !== 'function') return;

    storage
      .get(STORAGE_KEY)
      .then((stored) => {
        if (!cancelled) setHidden(stored === 'true');
      })
      .catch(() => {
        // A failed read only costs the remembered state, never the toggle itself.
      });

    return () => {
      cancelled = true;
    };
  }, [ctx]);

  const toggle = useCallback(() => {
    setHidden((current) => {
      const next = !current;

      // Optimistic: the button already flipped, so a storage failure must not
      // leave the UI disagreeing with itself.
      ctx?.api?.storage
        ?.set(STORAGE_KEY, String(next))
        ?.catch(() => {});

      return next;
    });
  }, [ctx]);

  return { hidden, toggle };
}

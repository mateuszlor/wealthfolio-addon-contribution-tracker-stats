import { useCallback, useEffect, useRef, useState } from 'react';
import type { AddonContext } from '@wealthfolio/addon-sdk';
import { getInitialIntervalData, type TimePeriod } from '@wealthfolio/ui';
import { stableRange, type DateWindow } from '../lib/window';

/**
 * `storage` keys are capped at 128 characters from `[A-Za-z0-9_.:-]`, and the
 * namespace keeps the addon prefix like the other hooks.
 */
const STORAGE_KEY = 'contribution-tracker-stats.window';

/**
 * The visible window, following the spending pages' two mechanisms: an
 * interval preset (`1Y`, `ALL`, …) or one concrete month.
 *
 * `@wealthfolio/ui`'s `IntervalSelector` persists its selection in
 * `localStorage` when given a `storageKey`, but the add-on runs in an iframe
 * created with `sandbox="allow-scripts"` — an opaque origin where every
 * `localStorage` read throws (`SecurityError`, visible in the host console).
 * The selector is therefore driven controlled, and this hook persists both the
 * interval code and the month key in the same bridge `useHiddenAmounts` uses.
 */
export type WindowSelection =
  | { kind: 'interval'; code: TimePeriod }
  | { kind: 'month'; key: string };

export interface PersistedWindowState {
  selection: WindowSelection;
  /** Range for the current selection, ready for `filterByRange`. */
  range: { from?: Date; to?: Date };
  setInterval: (code: TimePeriod) => void;
  setMonth: (key: string | null) => void;
}

/** The addon opens on the last year, the same default as before. */
const DEFAULT_SELECTION: WindowSelection = { kind: 'interval', code: '1Y' };

/** The host owns the interval table, so the addon reads rather than copies it. */
const intervalRange = (code: TimePeriod): DateWindow | undefined =>
  getInitialIntervalData(code).range;

function deserialise(stored: unknown): WindowSelection | undefined {
  if (typeof stored !== 'object' || stored === null) return undefined;
  const { kind, code, key } = stored as { kind?: unknown; code?: unknown; key?: unknown };
  if (kind === 'interval' && typeof code === 'string') {
    return { kind: 'interval', code: code as TimePeriod };
  }
  if (kind === 'month' && typeof key === 'string' && /^\d{4}-\d{2}$/.test(key)) {
    return { kind: 'month', key };
  }
  return undefined;
}

export function usePersistedWindow(ctx: AddonContext): PersistedWindowState {
  // The default renders immediately; a stored selection replaces it once the
  // async read resolves, so the first paint is never blocked on the bridge.
  const [selection, setSelection] = useState<WindowSelection>(DEFAULT_SELECTION);

  useEffect(() => {
    let cancelled = false;
    const storage = ctx?.api?.storage;

    if (!storage || typeof storage.get !== 'function') return;

    storage
      .get(STORAGE_KEY)
      .then((stored) => {
        if (cancelled) return;
        const parsed = deserialise(stored);
        if (parsed) setSelection(parsed);
      })
      .catch(() => {
        // A failed read only costs the remembered selection, never the page.
      });

    return () => {
      cancelled = true;
    };
  }, [ctx]);

  const persist = useCallback(
    (next: WindowSelection) => {
      setSelection(next);
      ctx?.api?.storage
        ?.set(STORAGE_KEY, JSON.stringify(next))
        ?.catch(() => {
          // Optimistic write: a failure costs the remembered selection only.
        });
    },
    [ctx],
  );

  const setInterval = useCallback(
    (code: TimePeriod) => persist({ kind: 'interval', code }),
    [persist],
  );

  const setMonth = useCallback(
    (key: string | null) => {
      // `null` returns to the interval preset instead of an empty window.
      if (key) persist({ kind: 'month', key });
      else persist({ kind: 'interval', code: selection.kind === 'interval' ? selection.code : '1Y' });
    },
    [persist, selection],
  );

  // Stable by value, so a click that sets the drill-down is not undone by this
  // render's effect. See `stableRange` in lib/window.ts.
  const range = useRef<DateWindow | undefined>(undefined);
  range.current = stableRange(selection, intervalRange, range.current);

  return { selection, range: range.current, setInterval, setMonth };
}

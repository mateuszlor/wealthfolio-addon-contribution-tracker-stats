import React from 'react';
import { useAddonTranslation } from '@wealthfolio/addon-sdk';
import {
  AmountDisplay,
  Icons,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  useAmountFormatting,
  useDateFormatting,
} from '@wealthfolio/ui';
import { maskAmount } from '../lib/privacy';
import type { ContributionRecord, Flow } from '../lib/contributions';

export interface DrillDownPanelProps {
  /** Whether the sheet is open (a bar or tooltip row is selected). */
  open: boolean;
  /** Fired on close (overlay click, escape, or the close button). */
  onOpenChange: (open: boolean) => void;
  /** Records for the selected period and account. */
  records: ContributionRecord[];
  /** The period label (e.g., "Jan 2026"). */
  periodLabel: string;
  /** Optional account name (for per-account view). */
  accountName?: string;
  /** Which ledger the panel is listing; the net view mixes both directions. */
  flow?: Flow;
  /**
   * For the +/- view: which direction was clicked. When set, the panel lists
   * only that direction's records and the caption names it.
   */
  direction?: 'deposits' | 'withdrawals';
  /** Total amount for the period/account. */
  total: number;
  /** Currency code. */
  currency: string;
  /** Whether amounts are hidden. */
  amountsHidden: boolean;
}

/**
 * Drill-down as a `Sheet`, the same primitive the performance attribution and
 * the spending transaction panels open. The previous inline card pushed the
 * chart down when a bar was clicked, which also scrolled the clicked bar out
 * of view on short screens; an overlay has neither problem.
 *
 * Focus moves into the dialog automatically (Radix traps it on open), so the
 * manual focus-to-close-button hack the card needed is gone.
 */
export function DrillDownPanel({
  open,
  onOpenChange,
  records,
  periodLabel,
  accountName,
  flow = 'deposits',
  direction,
  total,
  currency,
  amountsHidden,
}: DrillDownPanelProps) {
  const { t } = useAddonTranslation();
  const { formatAmount: formatHostAmount } = useAmountFormatting();
  const { formatDate: formatHostDate } = useDateFormatting();

  const formatDate = React.useCallback(
    (value: Date) =>
      formatHostDate(value, { day: '2-digit', month: 'short', year: 'numeric' }),
    [formatHostDate],
  );

  const displayValue = React.useCallback(
    (value: number) => maskAmount(formatHostAmount(value, currency), amountsHidden),
    [formatHostAmount, currency, amountsHidden],
  );

  const title = accountName
    ? `${t('detailsFor')} ${accountName} · ${periodLabel}`
    : `${t('detailsFor')} ${periodLabel}`;

  /** A caption distinguishing the ledgers on the same panel. In the +/- view,
   *  the direction the user clicked overrides the flow, so the panel names
   *  the bar that was clicked rather than the mixed ledger. */
  const flowCaption = direction
    ? direction === 'deposits' ? t('viewDeposits') : t('viewWithdrawals')
    : flow === 'withdrawals' ? t('viewWithdrawals')
    : flow === 'net' ? t('viewNet')
    : t('viewDeposits');

  // Newest first: the panel is a drill-down, so the most recent entry in the
  // period is the one being looked for.
  const ordered = React.useMemo(
    () => records.slice().sort((a, b) => b.date.getTime() - a.date.getTime()),
    [records],
  );

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      {/* End side, like the attribution sheet; on small screens it becomes a
          bottom sheet through the host's own responsive variants. */}
      <SheetContent side="right" className="flex w-full flex-col gap-0 sm:max-w-md">
        <SheetHeader className="border-b pb-3">
          <SheetTitle className="text-base font-medium">{title}</SheetTitle>
          <SheetDescription className="flex items-center justify-between gap-4">
            <span className="text-muted-foreground">
              {flowCaption} · {t('transactionCount', { count: records.length })}
            </span>
            <span className="tabular-nums font-semibold">
              <AmountDisplay value={total} currency={currency} isHidden={amountsHidden} />
            </span>
          </SheetDescription>
        </SheetHeader>

        {ordered.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            {t('noTransactionsInPeriod')}
          </p>
        ) : (
          <ul className="flex-1 space-y-2 overflow-y-auto p-4">
            {ordered.map((record, index) => (
              <li
                // `activityId` is empty when the host omits it, and two deposits
                // of the same amount on the same day are otherwise duplicates.
                key={record.activityId || `${record.date.getTime()}-${record.amount}-${index}`}
                className="flex flex-col gap-2 rounded-lg border bg-card p-3 transition-colors hover:bg-muted/50 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10">
                    <Icons.Calendar className="h-4 w-4 text-primary" />
                  </div>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      {formatDate(record.date)}
                      {flow === 'net' && (
                        <span
                          className={
                            record.flow === 'withdrawals'
                              ? 'ml-2 text-destructive'
                              : 'ml-2 text-muted-foreground'
                          }
                        >
                          {record.flow === 'withdrawals' ? '−' : '+'}
                        </span>
                      )}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">{record.accountName}</p>
                  </div>
                </div>
                <span className="tabular-nums whitespace-nowrap font-medium sm:text-right">
                  {displayValue(record.amount)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </SheetContent>
    </Sheet>
  );
}

import React from 'react';
import { useAddonTranslation } from '@wealthfolio/addon-sdk';
import {
  AmountDisplay,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Icons,
  useAmountFormatting,
  useDateFormatting,
} from '@wealthfolio/ui';
import { maskAmount } from '../lib/privacy';
import type { ContributionRecord } from '../lib/contributions';

export interface DrillDownPanelProps {
  /** Records for the selected period and account. */
  records: ContributionRecord[];
  /** The period label (e.g., "Jan 2026"). */
  periodLabel: string;
  /** Optional account name (for per-account view). */
  accountName?: string;
  /** Total amount for the period/account. */
  total: number;
  /** Currency code. */
  currency: string;
  /** Whether amounts are hidden. */
  amountsHidden: boolean;
  /** Called when the panel should close. */
  onClose: () => void;
}

export function DrillDownPanel({
  records,
  periodLabel,
  accountName,
  total,
  currency,
  amountsHidden,
  onClose,
}: DrillDownPanelProps) {
  const { t } = useAddonTranslation();
  const { formatAmount: formatHostAmount } = useAmountFormatting();
  const { formatDate: formatHostDate } = useDateFormatting();
  const closeRef = React.useRef<HTMLButtonElement>(null);

  // The panel opens from a pointer on a bar, and recharts' bars are not
  // focusable, so nothing in the flow would otherwise announce it or let the
  // keyboard user leave. Moving focus to the close button puts them inside.
  React.useEffect(() => {
    closeRef.current?.focus();
  }, []);

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

  // Newest first: the panel is a drill-down, so the most recent entry in the
  // period is the one being looked for.
  const ordered = React.useMemo(
    () => records.slice().sort((a, b) => b.date.getTime() - a.date.getTime()),
    [records],
  );

  return (
    <Card className="w-full">
      <CardHeader className="flex flex-row items-center justify-between border-b pb-3">
        <CardTitle className="text-base font-medium">{title}</CardTitle>
        <Button
          ref={closeRef}
          type="button"
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={onClose}
          aria-label={t('close')}
        >
          <Icons.X className="h-4 w-4" />
        </Button>
      </CardHeader>
      <CardContent className="pt-2">
        <div className="mb-4 flex items-center justify-between gap-4">
          <span className="text-sm text-muted-foreground">
            {t('transactionCount', { count: records.length })}
          </span>
          <span className="tabular-nums text-base font-semibold">
            <AmountDisplay value={total} currency={currency} isHidden={amountsHidden} />
          </span>
        </div>

        {ordered.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            {t('noTransactionsInPeriod')}
          </p>
        ) : (
          <ul className="max-h-64 space-y-2 overflow-y-auto">
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
                    <p className="truncate text-sm font-medium">{formatDate(record.date)}</p>
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
      </CardContent>
    </Card>
  );
}

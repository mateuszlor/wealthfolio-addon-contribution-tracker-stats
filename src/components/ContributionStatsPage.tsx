import React from 'react';
import { useAddonTranslation } from '@wealthfolio/addon-sdk';
import type { AddonContext } from '@wealthfolio/addon-sdk';
import {
  AmountDisplay,
  Button,
  FormattingProvider,
  Icons,
  IntervalSelector,
  Tabs,
  TabsList,
  TabsTrigger,
  ToggleGroup,
  ToggleGroupItem,
  getInitialIntervalData,
  useAmountFormatting,
  useDateFormatting,
  type TimePeriod,
} from '@wealthfolio/ui';
import { useContributions } from '../hooks/useContributions';
import { useHiddenAmounts } from '../hooks/useHiddenAmounts';
import { ContributionChart, seriesColor, type BarClickInfo, type ChartRow, type ChartSeries } from './ContributionChart';
import { CustomRangeButton } from './CustomRangeButton';
import { DrillDownPanel } from './DrillDownPanel';
import {
  bucketize,
  bucketizeByAccount,
  fillGaps,
  filterByRange,
  resolveAccountFromSeriesKey,
  selectDrillDownRecords,
  summarize,
  type Granularity,
} from '../lib/contributions';
import { maskAmount } from '../lib/privacy';

export interface ContributionStatsPageProps {
  ctx: AddonContext;
}

const GRANULARITIES: Granularity[] = ['month', 'day', 'year'];

type SeriesMode = 'total' | 'account';

const STORAGE_KEY = 'contribution-tracker-stats.interval';

const EMPTY_RANGE: CustomRange = { from: undefined, to: undefined };

type CustomRange = { from: Date | undefined; to: Date | undefined };

/**
 * Number, currency and date formatting is the host's, not the addon's: the built-in
 * `FormattingProvider` feeds `useAmountFormatting()` / `useDateFormatting()` /
 * `AmountDisplay`, so separators, fraction digits and the mask are exactly the ones
 * the application uses. The provider has to sit *above* the component that reads
 * those hooks, hence the split.
 */
export function ContributionStatsPage({ ctx }: ContributionStatsPageProps) {
  const { language } = useAddonTranslation();

  return (
    <FormattingProvider locale={language || 'en'} uiLocale={language || 'en'}>
      <ContributionStatsPageContent ctx={ctx} />
    </FormattingProvider>
  );
}

function ContributionStatsPageContent({ ctx }: ContributionStatsPageProps) {
  const { t, language } = useAddonTranslation();

  // Add-on-local privacy state, persisted in the host storage bridge. Wealthfolio's
  // own setting lives in `localStorage`, which throws in the opaque-origin sandbox,
  // and the host has no privacy bridge for add-ons yet.
  const { hidden: amountsHidden, toggle: toggleAmountsHidden } = useHiddenAmounts(ctx);

  // `locale` only labels the buckets now; amounts and dates come from the host
  // formatters above. Regional aliases are already normalised by the SDK.
  const locale = language || 'en';
  const { loading, error, records, granularity, setGranularity } = useContributions(ctx, locale);

  const [interval, setInterval] = React.useState<TimePeriod>('1Y');
  const [range, setRange] = React.useState<CustomRange>(
    () => getInitialIntervalData('1Y').range ?? EMPTY_RANGE,
  );
  const [customRange, setCustomRange] = React.useState<CustomRange | undefined>(undefined);
  const [seriesMode, setSeriesMode] = React.useState<SeriesMode>('total');
  const [drillDown, setDrillDown] = React.useState<{
    periodKey: string;
    periodLabel: string;
    accountId?: string;
    accountName?: string;
  } | null>(null);

  const currency = 'PLN';

  // The host formatters replace hand-rolled `Intl` calls: currency-aware fraction
  // digits, the application's own separators and the `formatCompactAmount` shape
  // the spending reports use on their axes.
  const { formatAmount, formatCompactAmount } = useAmountFormatting();
  const { formatDate: formatHostDate } = useDateFormatting();

  const formatDate = React.useCallback(
    (value: Date | undefined) =>
      value
        ? formatHostDate(value, { day: '2-digit', month: 'short', year: 'numeric' })
        : undefined,
    [formatHostDate],
  );

  // Axis ticks stay short; repeating the currency on every gridline is noise.
  const formatTick = React.useCallback(
    (value: number) => formatCompactAmount(value, currency, false),
    [formatCompactAmount, currency],
  );

  // The tooltip is a string, so `AmountDisplay` cannot render it; the mask is the
  // host's own, applied to the value the host formatter produced.
  const displayValue = React.useCallback(
    (value: number) => maskAmount(formatAmount(value, currency), amountsHidden),
    [formatAmount, currency, amountsHidden],
  );

  // The interval selector and the calendar share one window; a custom range wins
  // until an interval pill is picked again.
  const window = customRange ?? range;

  const scoped = React.useMemo(() => filterByRange(records, window), [records, window]);
  const stats = React.useMemo(() => summarize(scoped), [scoped]);
  const buckets = React.useMemo(
    () => fillGaps(bucketize(scoped, granularity, locale), granularity, locale),
    [scoped, granularity, locale],
  );

  const split = React.useMemo(
    () => bucketizeByAccount(scoped, granularity, locale),
    [scoped, granularity, locale],
  );

  // Splitting is meaningless with a single account, so the control only appears
  // once there is something to split.
  const canSplit = split.accounts.length > 1;
  const splitMode: SeriesMode = canSplit && seriesMode === 'account' ? 'account' : 'total';

  const { rows, series } = React.useMemo(() => {
    if (splitMode === 'account') {
      const next: ChartSeries[] = split.accounts.map((account, index) => {
        const dataKey = `s${index}`;
        return { dataKey, label: account.name, ...seriesColor(index) };
      });

      const data: ChartRow[] = split.buckets.map((bucket) => {
        const row: ChartRow = { label: bucket.label, periodKey: bucket.key };
        split.accounts.forEach((account, index) => {
          row[`s${index}`] = bucket.values[account.id] ?? 0;
        });
        return row;
      });

      return { rows: data, series: next };
    }

    return {
      rows: buckets.map((bucket) => ({ label: bucket.label, periodKey: bucket.key, total: bucket.total })),
      series: [
        {
          dataKey: 'total',
          label: t('totalContributions'),
          ...seriesColor(0),
        },
      ],
    };
  }, [splitMode, split, buckets, t]);

  // Toggling back to the total view after splitting is the expected round trip.
  React.useEffect(() => {
    if (!canSplit && seriesMode === 'account') setSeriesMode('total');
  }, [canSplit, seriesMode]);

  const handleIntervalSelect = React.useCallback(
    (code: TimePeriod, _description: string, next: CustomRange | undefined) => {
      setInterval(code);
      setRange(next ?? EMPTY_RANGE);
      setCustomRange(undefined);
    },
    [],
  );

  const handleRangeChange = React.useCallback((next: CustomRange | undefined) => {
    setCustomRange(next);
  }, []);

  const handleBarClick = React.useCallback(
    (info: BarClickInfo) => {
      // In the per-account view the chart identifies accounts positionally, so
      // the series key has to be resolved before it can be filtered on.
      if (splitMode === 'account') {
        const account = resolveAccountFromSeriesKey(split.accounts, info.dataKey);
        // A missing entry must not fall through to "no account", which would
        // list every account under this segment's name.
        if (!account) return;

        setDrillDown({
          periodKey: info.periodKey,
          periodLabel: info.periodLabel,
          accountId: account.id,
          accountName: account.name,
        });
        return;
      }

      setDrillDown({
        periodKey: info.periodKey,
        periodLabel: info.periodLabel,
        accountId: info.accountId,
        accountName: info.accountName,
      });
    },
    [splitMode, split.accounts],
  );

  const handleDrillDownClose = React.useCallback(() => {
    setDrillDown(null);
  }, []);

  // Anything that changes what the chart means invalidates an open panel:
  // granularity rewrites the period keys, the interval rewrites the record set,
  // and switching view changes which account the segment refers to.
  React.useEffect(() => {
    setDrillDown(null);
  }, [granularity, window, splitMode]);

  // The panel must list exactly the deposits the clicked bar is built from, so
  // it filters the same `scoped` set the chart uses. Filtering the unfiltered
  // `records` would pull in deposits outside the selected range on any partially
  // covered period — at Year granularity the `2025` bar under a 1Y window covers
  // Oct-Dec only, and the panel would then disagree with the bar it belongs to.
  const drillDownRecords = React.useMemo(() => {
    if (!drillDown) return [];
    return selectDrillDownRecords(scoped, drillDown, granularity);
  }, [drillDown, scoped, granularity]);

  const drillDownTotal = React.useMemo(
    () => drillDownRecords.reduce((sum, r) => sum + r.amount, 0),
    [drillDownRecords],
  );

  const rangeLabel =
    formatDate(window.from) && formatDate(window.to)
      ? `${formatDate(window.from)} – ${formatDate(window.to)}`
      : t('allTime');

  return (
    <div className="cts-root flex flex-col gap-4">
      <section className="flex flex-col gap-4 rounded-xl border p-4">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs tracking-wide text-muted-foreground uppercase">
              {t('totalContributions')}
            </p>
            {/* The host mask is shorter than a real total, so the slot keeps a
                minimum width and toggling does not shift the block. */}
            <p className="tabular-nums min-w-[9ch] text-3xl font-semibold">
              <AmountDisplay value={stats.total} currency={currency} isHidden={amountsHidden} />
            </p>
            <p className="text-xs text-muted-foreground">{rangeLabel}</p>
          </div>

          <div className="flex items-start gap-4">
            <dl className="flex gap-6 text-right">
              <div>
                <dt className="text-xs text-muted-foreground">{t('contributionCount')}</dt>
                <dd className="tabular-nums font-semibold">{stats.count}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">{t('averagePerDeposit')}</dt>
                <dd className="tabular-nums font-semibold">
                  <AmountDisplay value={stats.average} currency={currency} isHidden={amountsHidden} />
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">{t('averageMonthly')}</dt>
                <dd className="tabular-nums font-semibold">
                  <AmountDisplay
                    value={stats.monthlyAverage}
                    currency={currency}
                    isHidden={amountsHidden}
                  />
                </dd>
              </div>
            </dl>

            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="shrink-0"
              onClick={toggleAmountsHidden}
              aria-pressed={amountsHidden}
              aria-label={amountsHidden ? t('showAmounts') : t('hideAmounts')}
              title={amountsHidden ? t('showAmounts') : t('hideAmounts')}
            >
              {/* The icon states the action, like the host's own privacy toggle:
                  clicking the eye while hidden brings the amounts back. */}
              {amountsHidden ? (
                <Icons.Eye className="h-4 w-4" />
              ) : (
                <Icons.EyeOff className="h-4 w-4" />
              )}
            </Button>
          </div>
        </header>

        {error && (
          <p role="alert" className="text-destructive text-sm">
            {t('loadError', { message: error })}
          </p>
        )}

        {loading && !error && <p className="text-muted-foreground text-sm">{t('loading')}</p>}

        {!loading && !error && (
          <>
            {/* Same interval mechanism as the spending reports: preset pills plus
                the custom calendar range. */}
            <div className="flex items-center gap-2">
              <IntervalSelector
                value={interval}
                onIntervalSelect={handleIntervalSelect}
                storageKey={STORAGE_KEY}
              />
              <CustomRangeButton value={customRange} onApply={handleRangeChange} />
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3">
              <Tabs
                value={granularity}
                onValueChange={(value) => setGranularity(value as Granularity)}
              >
                <TabsList>
                  {GRANULARITIES.map((value) => (
                    <TabsTrigger key={value} value={value}>
                      {t(value)}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>

              {canSplit && (
                <ToggleGroup
                  type="single"
                  size="sm"
                  value={seriesMode}
                  onValueChange={(value) => {
                    if (value) setSeriesMode(value as SeriesMode);
                  }}
                >
                  <ToggleGroupItem value="total" variant="outline" aria-label={t('viewTotal')}>
                    {t('viewTotal')}
                  </ToggleGroupItem>
                  <ToggleGroupItem value="account" variant="outline" aria-label={t('viewPerAccount')}>
                    {t('viewPerAccount')}
                  </ToggleGroupItem>
                </ToggleGroup>
              )}
            </div>

            {rows.length === 0 ? (
              <p className="text-muted-foreground text-sm">{t('noContributions')}</p>
            ) : (
              <>
                <ContributionChart
                  rows={rows}
                  series={series}
                  formatValue={displayValue}
                  formatTick={formatTick}
                  hideAxis={amountsHidden}
                  onBarClick={handleBarClick}
                />
                {drillDown && (
                  <DrillDownPanel
                    records={drillDownRecords}
                    periodLabel={drillDown.periodLabel}
                    accountName={drillDown.accountName}
                    total={drillDownTotal}
                    currency={currency}
                    amountsHidden={amountsHidden}
                    onClose={handleDrillDownClose}
                  />
                )}
              </>
            )}
          </>
        )}
      </section>
    </div>
  );
}
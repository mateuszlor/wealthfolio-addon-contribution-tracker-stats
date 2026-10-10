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
  useAmountFormatting,
  useDateFormatting,
} from '@wealthfolio/ui';
import { useContributions } from '../hooks/useContributions';
import { useHiddenAmounts } from '../hooks/useHiddenAmounts';
import { usePersistedWindow } from '../hooks/usePersistedWindow';
import { ContributionChart, seriesColor, type BarClickInfo, type ChartRow, type ChartSeries } from './ContributionChart';
import { DrillDownPanel } from './DrillDownPanel';
import { MonthSwitcher } from './MonthSwitcher';
import {
  barClickToDrillDown,
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

/** Labels the hero, matching the spending reports' small caps. */
const HERO_LABEL_CLASS =
  'text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70';

/** This month, `YYYY-MM` — the month switcher's landing selection. */
function currentMonthKey(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

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

  // The visible window, following the spending pages: an interval preset or
  // one concrete month. Persisted in the same bridge as the privacy toggle.
  const { selection, range, setInterval, setMonth } = usePersistedWindow(ctx);

  // `locale` only labels the buckets now; amounts and dates come from the host
  // formatters above. Regional aliases are already normalised by the SDK.
  const locale = language || 'en';
  const { loading, error, records, granularity, setGranularity } = useContributions(ctx, locale);

  const [seriesMode, setSeriesMode] = React.useState<SeriesMode>('total');
  const [drillDown, setDrillDown] = React.useState<{
    periodKey: string;
    periodLabel: string;
    accountId?: string;
    accountName?: string;
  } | null>(null);

  /**
   * Deposits can be denominated in several currencies, and a total that adds
   * PLN to EUR is a number with no meaning. When every record shares one
   * currency the selector stays hidden; otherwise it narrows the whole page —
   * stats, chart and drill-down — to the chosen one, defaulting to the largest
   * contributor so the page still opens on the dominant currency.
   */
  const currencies = React.useMemo(
    () => Array.from(new Set(records.map((record) => record.currency))).sort(),
    [records],
  );

  const autoCurrency = React.useMemo(() => {
    const totals = new Map<string, number>();
    for (const record of records) {
      totals.set(record.currency, (totals.get(record.currency) ?? 0) + record.amount);
    }
    const best = Array.from(totals.entries()).sort((a, b) => b[1] - a[1])[0];
    return best?.[0] ?? 'PLN';
  }, [records]);

  const [currencyChoice, setCurrencyChoice] = React.useState<string | null>(null);
  const currency = currencyChoice ?? autoCurrency;

  const currencyRecords = React.useMemo(
    () => records.filter((record) => record.currency === currency),
    [records, currency],
  );

  // The earliest month with a deposit in this currency, bounding the month
  // switcher's back chevron.
  const minMonth = React.useMemo(() => {
    if (currencyRecords.length === 0) return undefined;
    const first = currencyRecords[0].date; // intake keeps records chronological
    return `${first.getFullYear()}-${String(first.getMonth() + 1).padStart(2, '0')}`;
  }, [currencyRecords]);

  // A month window is a single bucket at month granularity; browsing months in
  // day or year granularity would make the chart meaningless, so month mode
  // pins the aggregation like the spending pages pin theirs.
  React.useEffect(() => {
    if (selection.kind === 'month') setGranularity('month');
  }, [selection.kind, setGranularity]);

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

  const scoped = React.useMemo(
    () => filterByRange(currencyRecords, range),
    [currencyRecords, range],
  );
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

  const handleBarClick = React.useCallback(
    (info: BarClickInfo) => {
      // Only the per-account view has accounts behind its series keys. In the
      // total view there is nothing to resolve, so no account filter applies and
      // the panel lists the period.
      const accounts = splitMode === 'account' ? split.accounts : [];

      const selection = barClickToDrillDown(info, accounts);
      // A key that resolves to nothing must not fall through to "no account",
      // which would list every account under this segment's name.
      if (!selection) return;

      setDrillDown({
        periodKey: selection.periodKey,
        periodLabel: info.periodLabel,
        accountId: selection.accountId,
        accountName:
          selection.accountId && accounts.length > 0
            ? resolveAccountFromSeriesKey(accounts, info.dataKey)?.name
            : undefined,
      });
    },
    [splitMode, split.accounts],
  );

  // Anything that changes what the chart means invalidates an open panel:
  // granularity rewrites the period keys, the range rewrites the record set,
  // switching view changes which account the segment refers to, and a currency
  // switch swaps the whole record set.
  React.useEffect(() => {
    setDrillDown(null);
  }, [granularity, range, splitMode, currency]);

  // The panel must list exactly the deposits the clicked bar is built from, so
  // the selector applies the same window the chart was built from. It takes the
  // window rather than an already-scoped list, so the two cannot drift apart and
  // a test can cover the scoping instead of trusting this call site.
  const drillDownRecords = React.useMemo(() => {
    if (!drillDown) return [];
    return selectDrillDownRecords(currencyRecords, range, drillDown, granularity);
  }, [drillDown, currencyRecords, range, granularity]);

  const drillDownTotal = React.useMemo(
    () => drillDownRecords.reduce((sum, r) => sum + r.amount, 0),
    [drillDownRecords],
  );

  const rangeLabel =
    formatDate(range.from) && formatDate(range.to)
      ? `${formatDate(range.from)} – ${formatDate(range.to)}`
      : t('allTime');

  return (
    // Page margins are the addon's to own: the host mounts the route content
    // flush against the viewport, while the built-in pages pad their own
    // shells. Matches the spending page's rhythm (and clears its bottom bar).
    <div className="cts-root flex flex-col gap-4 p-4 pb-24 md:p-6 md:pb-24">
      <section className="rounded-xl border bg-card p-4 shadow-xs md:p-5">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className={HERO_LABEL_CLASS}>{t('totalContributions')}</p>
            {/* The host mask is shorter than a real total, so the slot keeps a
                minimum width and toggling does not shift the block. */}
            <p className="tabular-nums min-w-[9ch] text-3xl font-bold">
              <AmountDisplay value={stats.total} currency={currency} isHidden={amountsHidden} />
            </p>
            <p className="text-xs text-muted-foreground">{rangeLabel}</p>
          </div>

          <div className="flex items-start gap-4">
            <dl className="flex gap-6 text-right">
              <div>
                <dt className={HERO_LABEL_CLASS}>{t('contributionCount')}</dt>
                <dd className="tabular-nums font-semibold">{stats.count}</dd>
              </div>
              <div>
                <dt className={HERO_LABEL_CLASS}>{t('averagePerDeposit')}</dt>
                <dd className="tabular-nums font-semibold">
                  <AmountDisplay value={stats.average} currency={currency} isHidden={amountsHidden} />
                </dd>
              </div>
              <div>
                <dt className={HERO_LABEL_CLASS}>{t('averageMonthly')}</dt>
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
      </section>

      {!loading && !error && (
        <section className="rounded-xl border bg-card p-4 shadow-xs md:p-5">
          {/* Spending-style period controls: the same interval pills, plus a
              month switcher with chevrons and a month grid instead of a
              day-level calendar. Picking a month overrides the preset. */}
          <div className="flex flex-wrap items-center gap-2">
            <IntervalSelector
              value={selection.kind === 'interval' ? selection.code : undefined}
              onIntervalSelect={setInterval}
            />
            {minMonth && (
              <MonthSwitcher
                value={
                  selection.kind === 'month'
                    ? selection.key
                    : currentMonthKey()
                }
                onChange={setMonth}
                minMonth={minMonth}
                locale={locale}
              />
            )}
          </div>

          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
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

            <div className="flex flex-wrap items-center gap-3">
              {currencies.length > 1 && (
                <ToggleGroup
                  type="single"
                  size="sm"
                  value={currency}
                  onValueChange={(value) => {
                    if (value) setCurrencyChoice(value);
                  }}
                >
                  {currencies.map((code) => (
                    <ToggleGroupItem key={code} value={code} variant="outline" aria-label={code}>
                      {code}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              )}

              {canSplit && (
                <ToggleGroup
                  type="single"
                  size="sm"
                  value={splitMode}
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
          </div>

          {rows.length === 0 ? (
            <p className="mt-4 text-muted-foreground text-sm">{t('noContributions')}</p>
          ) : (
            <div className="mt-4">
              <ContributionChart
                rows={rows}
                series={series}
                formatValue={displayValue}
                formatTick={formatTick}
                hideAxis={amountsHidden}
                onBarClick={handleBarClick}
              />
            </div>
          )}
        </section>
      )}

      <DrillDownPanel
        open={drillDown !== null}
        onOpenChange={(open) => {
          if (!open) setDrillDown(null);
        }}
        records={drillDownRecords}
        periodLabel={drillDown?.periodLabel ?? ''}
        accountName={drillDown?.accountName}
        total={drillDownTotal}
        currency={currency}
        amountsHidden={amountsHidden}
      />
    </div>
  );
}

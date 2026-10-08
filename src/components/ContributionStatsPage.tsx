import React from 'react';
import { useAddonTranslation } from '@wealthfolio/addon-sdk';
import type { AddonContext } from '@wealthfolio/addon-sdk';
import {
  IntervalSelector,
  Tabs,
  TabsList,
  TabsTrigger,
  getInitialIntervalData,
  type TimePeriod,
} from '@wealthfolio/ui';
import { useContributions } from '../hooks/useContributions';
import { ContributionChart } from './ContributionChart';
import { CustomRangeButton } from './CustomRangeButton';
import { bucketize, fillGaps, filterByRange, summarize, type Granularity } from '../lib/contributions';

export interface ContributionStatsPageProps {
  ctx: AddonContext;
}

const GRANULARITIES: Granularity[] = ['month', 'day', 'year'];

const STORAGE_KEY = 'contribution-tracker-stats.interval';

const EMPTY_RANGE: CustomRange = { from: undefined, to: undefined };

type CustomRange = { from: Date | undefined; to: Date | undefined };

export function ContributionStatsPage({ ctx }: ContributionStatsPageProps) {
  const { t, language } = useAddonTranslation();

  // The host language is canonical and regional aliases are already normalised,
  // so it is the single source for number and date formatting.
  const locale = language || 'en';
  const { loading, error, records, granularity, setGranularity } = useContributions(ctx, locale);

  const [interval, setInterval] = React.useState<TimePeriod>('1Y');
  const [range, setRange] = React.useState<CustomRange>(
    () => getInitialIntervalData('1Y').range ?? EMPTY_RANGE,
  );
  const [customRange, setCustomRange] = React.useState<CustomRange | undefined>(undefined);

  const currency = 'PLN';

  const formatCurrency = React.useCallback(
    (value: number) =>
      new Intl.NumberFormat(locale, {
        style: 'currency',
        currency,
        maximumFractionDigits: 0,
      }).format(value),
    [locale],
  );

  // Axis ticks stay short; repeating the currency on every gridline is noise.
  const formatTick = React.useCallback(
    (value: number) =>
      new Intl.NumberFormat(locale, {
        notation: 'compact',
        maximumFractionDigits: 1,
      }).format(value),
    [locale],
  );

  const formatDate = React.useCallback(
    (value: Date | undefined) =>
      value
        ? new Intl.DateTimeFormat(locale, { day: '2-digit', month: 'short', year: 'numeric' }).format(
            value,
          )
        : undefined,
    [locale],
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
            <p className="tabular-nums text-3xl font-semibold">
              {formatCurrency(stats.total)}
            </p>
            <p className="text-xs text-muted-foreground">{rangeLabel}</p>
          </div>

          <dl className="flex gap-6 text-right">
            <div>
              <dt className="text-xs text-muted-foreground">{t('contributionCount')}</dt>
              <dd className="tabular-nums font-semibold">{stats.count}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground text-xs">{t('averagePerDeposit')}</dt>
              <dd className="tabular-nums font-semibold">{formatCurrency(stats.average)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">{t('averageMonthly')}</dt>
              <dd className="tabular-nums font-semibold">
                {formatCurrency(stats.monthlyAverage)}
              </dd>
            </div>
          </dl>
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

            {buckets.length === 0 ? (
              <p className="text-muted-foreground text-sm">{t('noContributions')}</p>
            ) : (
              <ContributionChart
                buckets={buckets}
                formatValue={formatCurrency}
                formatTick={formatTick}
              />
            )}
          </>
        )}
      </section>
    </div>
  );
}

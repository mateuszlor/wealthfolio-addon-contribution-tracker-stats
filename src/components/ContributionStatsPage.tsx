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
import { useAccountScope } from '../hooks/useAccountScope';
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
  selectFlow,
  signedAmount,
  summarize,
  type Flow,
  type Granularity,
} from '../lib/contributions';
import { scopeRecords } from '../hooks/useAccountScope';
import { useConvertedRecords } from '../hooks/useConvertedRecords';
import { maskAmount } from '../lib/privacy';

export interface ContributionStatsPageProps {
  ctx: AddonContext;
}

const GRANULARITIES: Granularity[] = ['month', 'day', 'year'];

type SeriesMode = 'total' | 'account';

/** The three ledgers of the flow switch, in display order. */
const FLOWS: Flow[] = ['deposits', 'withdrawals', 'net'];

const FLOW_LABEL_KEY: Record<Flow, string> = {
  deposits: 'viewDeposits',
  withdrawals: 'viewWithdrawals',
  net: 'viewNet',
};

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

  // Investment and cash accounts only: the two account groups the flow ledger
  // is meaningful for. Credit-card rows never reach the aggregation below.
  // `scopeDegraded` means no account type could be read at all, so the gate is
  // open and the page says so rather than implying the exclusion still holds.
  const { includedIds, degraded: scopeDegraded } = useAccountScope(ctx);

  // `locale` only labels the buckets now; amounts and dates come from the host
  // formatters above. Regional aliases are already normalised by the SDK.
  const locale = language || 'en';
  const { loading, error, records, granularity, setGranularity } = useContributions(ctx, locale);

  const [seriesMode, setSeriesMode] = React.useState<SeriesMode>('total');
  // Which ledger the page shows: deposits, withdrawals, or the signed net of
  // both. Layout mirrors the visibility switch so the meaning of every other
  // control on the page is now "of the selected flow".
  const [flow, setFlow] = React.useState<Flow>('deposits');
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
   *
   * A third option — "ALL (PLN)" — converts **every** record to the host's
   * base currency through its own exchange-rate engine
   * (`exchangeRates.getRatesForDates`, historical per-activity rates), the
   * same rules the host's `invested` figure uses. A single-currency page is
   * unchanged: with one currency the selector is hidden either way.
   */
  const currencies = React.useMemo(
    () => Array.from(new Set(records.map((record) => record.currency))).sort(),
    [records],
  );

  const autoCurrency = React.useMemo(() => {
    const totals = new Map<string, number>();
    for (const record of records) {
      const signed = signedAmount(record, flow);
      totals.set(record.currency, (totals.get(record.currency) ?? 0) + signed);
    }
    // Largest by absolute volume, so a dominant withdrawal currency also wins.
    const best = Array.from(totals.entries()).sort(
      (a, b) => Math.abs(b[1]) - Math.abs(a[1]),
    )[0];
    return best?.[0] ?? 'PLN';
  }, [records, flow]);

  /** Sentinel for the converted view; a real currency code can never be this. */
  const CURRENCY_ALL = '{{all}}';

  const [currencyChoice, setCurrencyChoice] = React.useState<string | null>(null);
  const allRequested = currencyChoice === CURRENCY_ALL;
  const viewCurrency = allRequested ? null : currencyChoice ?? autoCurrency;

  /**
   * Conversion only runs while the ALL view is on. The hook returns `undefined`
   * records while the rates are in flight, so the page keeps its previous
   * rendering state rather than flashing an empty chart on every choice click.
   *
   * `dropped` — rows the bridge could not price — is surfaced next to the
   * interval bar, the same way `intake` explains an unexpectedly small total.
   */
  const { records: allRecords, dropped: convertDropped, baseCurrency } = useConvertedRecords(ctx, records);
  const conversionVisible = allRequested && baseCurrency !== undefined;

  // What the rest of the page sees: either the per-currency slice (the old
  // path, unchanged) or the host-converted whole in the base currency.
  const scopedRecords = conversionVisible ? allRecords : null;

  const currencyRecords = React.useMemo(
    () =>
      scopeRecords(
        conversionVisible
          ? scopedRecords ?? []
          : records.filter((record) => record.currency === viewCurrency),
        includedIds,
      ),
    [records, viewCurrency, includedIds, conversionVisible, scopedRecords],
  );

  // The ALL view reports its currency through the host setting, not through
  // `viewCurrency` (which is null there): the hero, axis and drill-down all
  // format through this one binding, so the whole page flips in one place.
  const currency = allRequested ? (baseCurrency ?? 'PLN') : (viewCurrency ?? 'PLN');

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

  // Which flows exist decides whether the flow switch means anything: a ledger of
  // deposits alone has no second side to switch to.
  //
  // This reads the **loaded records, not the window**. It used to read `scoped`,
  // and that was the bug in two directions: narrowing the range emptied the
  // window, `hasWithdrawals` went false, and the switch the user was holding
  // disappeared. Whether a *second ledger exists at all* is a property of the
  // data, not of the period being viewed — the period decides whether that
  // ledger has anything to show, which is a separate question and is answered by
  // rendering an empty chart, not by deleting the control that reaches it.
  const hasWithdrawals = React.useMemo(
    () => records.some((record) => record.flow === 'withdrawals'),
    [records],
  );

  // Everything below aggregates the flow the user picked, `flow`, with no
  // intermediate name that could resolve to something else. There is no
  // `effectiveFlow`: a window without withdrawals shows an empty withdrawals
  // ledger, which is the answer to the question that was asked. Substituting the
  // side that does have records would relabel the hero total, the buckets, the
  // split and the drill-down behind the user's back.

  // `summarize` signs but does not filter, so the single-flow views get exactly
  // their side of the ledger first; the net view keeps both.
  const flowRecords = React.useMemo(
    () => selectFlow(scoped, flow),
    [scoped, flow],
  );

  const stats = React.useMemo(
    () => summarize(flowRecords, flow),
    [flowRecords, flow],
  );
  const buckets = React.useMemo(
    () =>
      fillGaps(
        bucketize(
          flowRecords,
          granularity,
          locale,
          flow,
        ),
        granularity,
        locale,
      ),
    [flowRecords, granularity, locale, flow],
  );

  // The split carries both flows under the net lead, so each bucket holds the
  // signed value of its account for the period. It takes the *filtered*
  // `flowRecords`, not `scoped`: under the deposits or withdrawals view an
  // unfiltered list leaks the opposite flow into the stack, which is exactly
  // how the withdrawals chart ended up reading deposits' bars.
  const split = React.useMemo(
    () => bucketizeByAccount(flowRecords, granularity, locale, flow),
    [flowRecords, granularity, locale, flow],
  );

  // Splitting needs more than one account, so the control only appears once there
  // is something to split — and that is counted over the **loaded records**, not
  // the window. Gating on `split.accounts` (window-scoped) deleted the switch
  // the user was holding the moment they narrowed the range to a period with no
  // records, stranding them in per-account mode with no way out. Same root cause
  // as the flow switch above: capability is a property of the data, emptiness is
  // a property of the period.
  const canSplit = React.useMemo(
    () => new Set(records.map((record) => record.accountId)).size > 1,
    [records],
  );

  // The user's selection is honoured even when the window holds nothing to split.
  // An empty per-account chart is the honest rendering of an empty period; the
  // alternative — quietly falling back to the total view — is the silent swap
  // this page stopped doing for ledgers, and it would be worse here.
  const splitMode: SeriesMode = seriesMode;

  // The withdrawals ledger reads as spending, not growth: the chart palette
  // shifts so the bars do not read as "money added". The net view keeps the
  // contributory green, because its bars stay meaningful in both directions.
  const chartColorOffset = flow === 'withdrawals' ? 5 : 0; // 5 = rose slot

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
          label:
            flow === 'withdrawals' ? t('viewWithdrawals')
              : flow === 'net' ? t('netFlow')
              : t('totalContributions'),
          ...seriesColor(chartColorOffset),
        },
      ],
    };
  }, [splitMode, split, buckets, t, flow]);

  // There is deliberately no effect forcing `seriesMode` back to `total` when
  // `canSplit` goes false. That round trip was the bug: `canSplit` is scoped to
  // the window, so narrowing the range emptied it, the effect reset the mode,
  // and the control the user was holding disappeared in the same commit that
  // emptied it. The user's selection is now theirs to change.

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
  // Granularity rewrites the period keys, switching view changes which account
  // a segment refers to, and a currency switch swaps the whole record set.
  //
  // The range is deliberately absent. React compares it by identity, and any
  // window rebuilt during render would re-run this on every render, closing a
  // panel in the same commit that the click opened it. `stableRange` keeps the
  // identity steady, but the reset does not need the window at all: the panel's
  // records are already scoped through it, so a panel left open across a window
  // change re-reads the new range rather than showing the old one's deposits.
  React.useEffect(() => {
    setDrillDown(null);
  }, [granularity, splitMode, currency, flow]);

  // The panel must list exactly the flows the clicked bar is built from, so
  // the selector applies the same window the chart was built from. It takes the
  // window rather than an already-scoped list, so the two cannot drift apart and
  // a test can cover the scoping instead of trusting this call site.
  const drillDownRecords = React.useMemo(() => {
    if (!drillDown) return [];
    return selectDrillDownRecords(currencyRecords, range, drillDown, granularity, flow);
  }, [drillDown, currencyRecords, range, granularity, flow]);

  const drillDownTotal = React.useMemo(
    () => drillDownRecords.reduce((sum, r) => sum + signedAmount(r, flow), 0),
    [drillDownRecords, flow],
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
            <p className={HERO_LABEL_CLASS}>
              {flow === 'withdrawals' ? t('totalWithdrawn')
                : flow === 'net' ? t('netFlow')
                : t('totalContributions')}
            </p>
            {/* The host mask is shorter than a real total, so the slot keeps a
                minimum width and toggling does not shift the block. */}
            <p className="tabular-nums min-w-[9ch] text-3xl font-bold">
              <AmountDisplay value={stats.total} currency={currency} isHidden={amountsHidden} />
            </p>
            <p className="text-xs text-muted-foreground">{rangeLabel}</p>
            {/* What the numbers cover. The excluded-account note is the rule; the
                degraded one replaces it when the account types could not be read
                and the exclusion is therefore not being applied. */}
            <p
              className={
                scopeDegraded
                  ? 'text-destructive text-xs'
                  : 'text-muted-foreground text-xs'
              }
            >
              {scopeDegraded ? t('scopeUnavailable') : t('barredByScope')}
            </p>
          </div>

          <div className="flex items-start gap-4">
            <dl className="flex gap-6 text-right">
              <div>
                <dt className={HERO_LABEL_CLASS}>
                  {flow === 'withdrawals' ? t('withdrawalCount') : t('contributionCount')}
                </dt>
                <dd className="tabular-nums font-semibold">{stats.count}</dd>
              </div>
              <div>
                <dt className={HERO_LABEL_CLASS}>
                  {flow === 'withdrawals'
                    ? t('averagePerWithdrawal')
                    : flow === 'net'
                      ? t('averagePerDeposit')
                      : t('averagePerDeposit')}
                </dt>
                <dd className="tabular-nums font-semibold">
                  <AmountDisplay value={stats.average} currency={currency} isHidden={amountsHidden} />
                </dd>
              </div>
              <div>
                <dt className={HERO_LABEL_CLASS}>
                  {flow === 'net' ? t('netMonthly') : t('averageMonthly')}
                </dt>
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

        {conversionVisible && convertDropped > 0 && (
          <p role="status" className="text-muted-foreground text-xs">
            {t('conversionDropped', { count: convertDropped })}
          </p>
        )}
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
              {/* The three ledgers: deposits, withdrawals and their signed net. A ledger of
              deposits alone has no second side to switch to, so the switch waits
              for a withdrawal to exist — **but not once the user is holding one
              of the other two**. `hasWithdrawals` is scoped to the window, and
              narrowing the range empties it, which deleted the switch and left
              the user in a ledger they could not leave. The guard is on the
              user's own selection, so it survives in both directions. Nothing
              here changes the selection: an empty ledger stays empty. */}
              {(hasWithdrawals || flow !== 'deposits') && (
                <ToggleGroup
                  type="single"
                  size="sm"
                  value={flow}
                  onValueChange={(value) => {
                    if (value) setFlow(value as Flow);
                  }}
                >
                  {FLOWS.map((value) => (
                    <ToggleGroupItem
                      key={value}
                      value={value}
                      variant="outline"
                      aria-label={t(FLOW_LABEL_KEY[value])}
                    >
                      {t(FLOW_LABEL_KEY[value])}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              )}

              {currencies.length > 1 && (
                <ToggleGroup
                  type="single"
                  size="sm"
                  value={allRequested ? CURRENCY_ALL : currency}
                  onValueChange={(value) => {
                    if (value) setCurrencyChoice(value);
                  }}
                >
                  {currencies.map((code) => (
                    <ToggleGroupItem key={code} value={code} variant="outline" aria-label={code}>
                      {code}
                    </ToggleGroupItem>
                  ))}
                  <ToggleGroupItem
                    value={CURRENCY_ALL}
                    variant="outline"
                    aria-label={t('viewAllCurrency', { code: baseCurrency ?? 'PLN' })}
                  >
                    {t('viewAllCurrency', { code: baseCurrency ?? 'PLN' })}
                  </ToggleGroupItem>
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
            // Says which ledger is empty. "No contributions" under a withdrawals
            // heading answers a question nobody asked.
            <p className="mt-4 text-muted-foreground text-sm">
              {flow === 'withdrawals' ? t('noWithdrawals') : t('noContributions')}
            </p>
          ) : (
            <div className="mt-4">
              <ContributionChart
                rows={rows}
                series={series}
                formatValue={displayValue}
                formatTick={formatTick}
                colorOffset={chartColorOffset}
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
        flow={flow}
        total={drillDownTotal}
        currency={currency}
        amountsHidden={amountsHidden}
      />
    </div>
  );
}

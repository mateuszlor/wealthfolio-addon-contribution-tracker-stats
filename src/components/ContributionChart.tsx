import React from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  XAxis,
  YAxis,
  type ChartConfig,
} from '@wealthfolio/ui/chart';

export interface ChartSeries {
  /** Field name on each row. Kept short because it is also a CSS identifier. */
  dataKey: string;
  label: string;
}

export interface ChartRow {
  /** Human readable label for the axis (e.g., "Jan 2026"). */
  label: string;
  /** Machine-readable period key (e.g., "2026-01"). Used for drill-down filtering. */
  periodKey: string;
  [dataKey: string]: string | number;
}

/** Information about the bar segment that was selected. */
export interface BarClickInfo {
  /** The period label (e.g., "Jan 2026"). */
  periodLabel: string;
  /** The period key (e.g., "2026-01"). */
  periodKey: string;
  /** The account id (undefined for total view). */
  accountId?: string;
  /** The account name (undefined for total view). */
  accountName?: string;
  /** The value of the segment. */
  value: number;
  /** The series dataKey (e.g., "s0" or "total"). */
  dataKey: string;
}

export interface ContributionChartProps {
  rows: ChartRow[];
  series: ChartSeries[];
  formatValue: (value: number) => string;
  /** Compact axis ticks; the currency belongs in the tooltip, not on every tick. */
  formatTick: (value: number) => string;
  /**
   * Hides the value axis while amounts are masked. A masked tick would still
   * spell out its unit (`••• mln`), so the axis goes away instead of being
   * masked — the same choice the host's net-worth chart makes.
   */
  hideAxis?: boolean;
  /** Called when a bar is clicked, or a tooltip row is activated. */
  onBarClick?: (info: BarClickInfo) => void;
}

/**
 * Colour for the nth series — curated muted palette matching Wealthfolio's
 * design language (see screenshots). Colours are sophisticated, not pastel:
 * lower saturation, balanced lightness, good contrast in both themes.
 *
 * Index 0 = green (contributions), then blue, purple, amber, teal, rose...
 * Beyond the palette length the golden angle takes over so hues never repeat.
 */
export function seriesColor(index: number): { light: string; dark: string } {
  // Hand-picked muted hues that sit well in Wealthfolio's UI (both light/dark).
  // Saturation ~25-30%, lightness tuned per hue for consistent perceived brightness.
  const curated: Array<{ light: string; dark: string }> = [
    { light: 'hsl(142 28% 38%)', dark: 'hsl(142 28% 52%)' },  // green (contributions)
    { light: 'hsl(217 30% 42%)', dark: 'hsl(217 30% 58%)' },  // blue
    { light: 'hsl(262 28% 44%)', dark: 'hsl(262 28% 60%)' },  // purple
    { light: 'hsl(28 28% 42%)',  dark: 'hsl(28 28% 58%)' },   // amber
    { light: 'hsl(185 28% 38%)', dark: 'hsl(185 28% 54%)' },  // teal
    { light: 'hsl(340 26% 42%)', dark: 'hsl(340 26% 58%)' },  // rose
    { light: 'hsl(45 28% 44%)',  dark: 'hsl(45 28% 60%)' },   // gold
    { light: 'hsl(280 26% 44%)', dark: 'hsl(280 26% 60%)' },  // violet
  ];

  if (index < curated.length) return curated[index];

  // Fallback: golden angle with same muted saturation/lightness range.
  const hue = (142 + (index - curated.length + 1) * 137.508) % 360;
  return {
    light: `hsl(${hue} 28% 40%)`,
    dark: `hsl(${hue} 28% 56%)`,
  };
}

/**
 * Builds the chart config.
 *
 * Colours are literal rather than `var(--chart-1)`: `ChartStyle` expands the
 * config into `--color-<key>`, so a token-based colour leaves `fill` unresolved
 * and the bars render black whenever the token is missing.
 */
function buildConfig(series: ChartSeries[]): ChartConfig {
  const config: ChartConfig = {};
  series.forEach((item, index) => {
    const color = seriesColor(index);
    config[item.dataKey] = {
      label: item.label,
      theme: { light: color.light, dark: color.dark },
    };
  });
  return config;
}

/** A column under the cursor, plus the pixel anchor for the tooltip. */
interface HoverState {
  row: ChartRow;
  /** Centre x of the hovered column, in chart pixels. */
  centre: number;
  /** Left edge of the hovered column, in chart pixels. */
  left: number;
  /** Width of the hovered column, in chart pixels. */
  width: number;
  /** Top y of the hovered segment, in chart pixels. */
  y: number;
  /** The plot area, relative to the chart container, for the column highlight. */
  plot: { top: number; height: number };
}

/**
 * Tooltip rendered by us instead of recharts.
 *
 * Recharts' own tooltip is a transient hover overlay: its wrapper is painted
 * with `pointer-events: none`, so a clickable row inside it can never receive a
 * click - the bar underneath gets it. `allowEscapeViewBox`, `wrapperStyle` and
 * `trigger` do not change that, because the limitation is in the wrapper the
 * library always renders.
 *
 * It is a child of `ChartContainer` rather than a sibling, because `ChartStyle`
 * emits `--color-<key>` on that element and custom properties only inherit
 * downwards; as a sibling the swatches resolved to transparent.
 *
 * It renders whenever a bar is hovered whether or not `onSelect` was passed, so
 * the component keeps the tooltip it had before the drill-down existed. Rows are
 * interactive only when there is somewhere to send the selection.
 */
function InteractiveTooltip({
  hover,
  series,
  formatValue,
  onSelect,
  ref,
}: {
  hover: HoverState;
  series: ChartSeries[];
  formatValue: (value: number) => string;
  onSelect?: (info: BarClickInfo) => void;
  ref?: React.Ref<HTMLDivElement>;
}) {
  const { row } = hover;
  const stacked = series.length > 1;

  // Zeroes are dropped in both modes. In the stacked view `bucketizeByAccount`
  // zero-fills every account to keep the stack order stable, and a row that
  // opens an empty panel is worse than no row at all.
  const entries = series
    .map((item) => ({ item, value: Number(row[item.dataKey] ?? 0) }))
    .filter((entry) => entry.value !== 0);

  const total = entries.reduce((sum, entry) => sum + entry.value, 0);

  const select = (item: ChartSeries, value: number) =>
    onSelect?.({
      periodLabel: String(row.label),
      periodKey: String(row.periodKey),
      accountId: item.dataKey === 'total' ? undefined : item.dataKey,
      accountName: item.dataKey === 'total' ? undefined : item.label,
      value,
      dataKey: item.dataKey,
    });

  /** Swatch plus series name, shared by the interactive and static row. */
  const identity = (item: ChartSeries) => (
    <span className="flex min-w-0 items-center gap-1.5">
      <span
        aria-hidden
        className="h-2 w-2 shrink-0 rounded-[2px]"
        style={{ backgroundColor: `var(--color-${item.dataKey})` }}
      />
      <span className="text-muted-foreground truncate">{item.label}</span>
    </span>
  );

  const amount = (value: number) => (
    <span className="tabular-nums font-medium">{formatValue(value)}</span>
  );

  return (
    <div
      ref={ref}
      // Above the chart surface and the legend; the only element here that opts
      // back into hit testing.
      className="pointer-events-auto absolute z-50"
      style={{
        left: `${hover.centre}px`,
        top: `${hover.y}px`,
        transform: 'translate(-50%, calc(-100% - 12px))',
      }}
    >
      <div className="border-border/50 bg-background grid max-w-64 min-w-36 items-start gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs shadow-xl">
        <div className="flex items-center justify-between gap-6 font-medium">
          <span className="truncate">{String(row.label)}</span>
          {/* With a single series the only row already shows the amount. */}
          {stacked && amount(total)}
        </div>

        <div className="grid gap-0.5">
          {entries.map(({ item, value }) =>
            onSelect ? (
              <button
                key={item.dataKey}
                type="button"
                onClick={() => select(item, value)}
                aria-label={`${item.label}: ${formatValue(value)}`}
                className="hover:bg-muted/60 flex w-full cursor-pointer items-center justify-between gap-6 rounded px-1 text-left"
              >
                {identity(item)}
                {amount(value)}
              </button>
            ) : (
              <div
                key={item.dataKey}
                className="flex w-full items-center justify-between gap-6 px-1"
              >
                {identity(item)}
                {amount(value)}
              </div>
            ),
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Native Wealthfolio chart: the same `ChartContainer` / `ChartLegendContent`
 * primitives the spending reports use, so colours follow the host theme.
 *
 * Renders one bar per series. With a single series that is a plain bar chart; with
 * several they share a `stackId` and form a stacked column, which is what the
 * per-account view needs.
 */
export function ContributionChart({
  rows,
  series,
  formatValue,
  formatTick,
  hideAxis = false,
  onBarClick,
}: ContributionChartProps) {
  const [hover, setHover] = React.useState<HoverState | undefined>(undefined);
  const [anchor, setAnchor] = React.useState<number | undefined>(undefined);
  const wrapperRef = React.useRef<HTMLDivElement>(null);
  const tooltipRef = React.useRef<HTMLDivElement>(null);

  if (rows.length === 0 || series.length === 0) return null;

  const stacked = series.length > 1;

  // `ChartLegendContent` reads the swatch colour from the payload item and the
  // label from the chart config by `dataKey`, so both have to be present.
  // `nameKey` is deliberately omitted: the config is keyed by dataKey, and
  // passing `nameKey="label"` looked up a key that does not exist.
  const legendPayload = series.map((item) => ({
    dataKey: item.dataKey,
    value: item.label,
    color: `var(--color-${item.dataKey})`,
  }));

  /**
   * Keeps the tooltip fully inside the chart.
   *
   * The tooltip is centred on the column, so the ones at either edge would push
   * half of it past the boundary and its rows would be unreachable. The width is
   * measured rather than assumed: a row is `label + gap + amount`, and a long
   * account name can exceed any constant.
   */
  React.useLayoutEffect(() => {
    if (anchor === undefined || !hover) return;

    const wrapperWidth = wrapperRef.current?.offsetWidth ?? 0;
    const half = (tooltipRef.current?.offsetWidth ?? 0) / 2;

    if (!wrapperWidth || !half) return;

    const margin = 4;
    const min = half + margin;
    const max = Math.max(min, wrapperWidth - half - margin);
    const next = Math.min(Math.max(anchor, min), max);

    setAnchor((current) => (current === next ? current : next));
  }, [anchor, hover, series.length, rows.length]);

  /** Column geometry as recharts reports it on the mouse events. */
  const geometry = (entry: unknown): Omit<HoverState, 'row' | 'plot'> | undefined => {
    const box = entry as { x?: number; y?: number; width?: number } | null | undefined;
    const left = Number(box?.x);
    const y = Number(box?.y);
    const width = Number(box?.width);

    if (!Number.isFinite(left) || !Number.isFinite(y) || !Number.isFinite(width)) return undefined;

    // recharts reports the band's *left edge*, not its centre: the coordinate
    // comes from the scale as a band start, so the centre has to be derived.
    return { left, width, y, centre: left + width / 2 };
  };

  /**
   * The plot area, so the column highlight does not spill over the axis labels
   * and the legend.
   *
   * Spanning the whole container was what made the hover state look wrong: the
   * wash covered the x-axis captions and ran under the legend. recharts' own
   * cursor was confined to the plot, and so is this.
   *
   * The grid is the chart's own account of where the plot is; the fallback stops
   * at the legend, which is the other thing the highlight must not cross.
   */
  const plotArea = React.useCallback((segmentTop: number) => {
    const container = wrapperRef.current;
    if (!container) return { top: segmentTop, height: 0 };

    const base = container.getBoundingClientRect();
    const grid = container.querySelector('.recharts-cartesian-grid');
    const gridBox = grid?.getBoundingClientRect();

    if (gridBox && gridBox.height > 0) {
      return { top: gridBox.top - base.top, height: gridBox.height };
    }

    const legend = container.querySelector('.recharts-legend-wrapper');
    const legendTop = legend
      ? legend.getBoundingClientRect().top - base.top
      : base.height;

    return { top: segmentTop, height: Math.max(0, legendTop - segmentTop) };
  }, []);

  return (
    // `onMouseLeave` belongs on this wrapper, not on the chart. The tooltip is
    // drawn above the hovered bar, so reaching it means leaving the bar: with the
    // handler on the chart the tooltip was torn down the instant the pointer
    // started moving towards it, which is why it could never be clicked. The gap
    // between the two lives inside this wrapper, and the tooltip is a DOM
    // descendant of it, so neither crossing the gap nor entering the tooltip
    // counts as leaving.
    <div
      ref={wrapperRef}
      className="relative"
      onMouseLeave={() => {
        setHover(undefined);
        setAnchor(undefined);
      }}
    >
      <ChartContainer
        config={buildConfig(series)}
        className="h-[280px] w-full aspect-auto"
      >
        <BarChart data={rows} margin={{ left: 4, right: 8, top: 8, bottom: 0 }}>
          <CartesianGrid vertical={false} />
          <XAxis
            dataKey="label"
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            minTickGap={16}
          />
          <YAxis
            hide={hideAxis}
            tickLine={false}
            axisLine={false}
            tickMargin={4}
            width={56}
            className="tabular-nums"
            tickFormatter={(value: number) => formatTick(value)}
          />
          {series.map((item, index) => (
            <Bar
              key={item.dataKey}
              dataKey={item.dataKey}
              name={item.label}
              // The addon mounts inside a sandboxed iframe where the
              // ResponsiveContainer can measure while its parent is still laid
              // out; the grow-in animation then starts from a zero-height
              // container and recharts logs `width(-1) height(-1)`. Bars are
              // data, not decoration, so they appear without transition.
              isAnimationActive={false}
              stackId={stacked ? 'contributions' : undefined}
              fill={`var(--color-${item.dataKey})`}
              // Only the topmost segment gets rounded corners, otherwise stacked
              // segments show rounded edges in the middle of the column.
              radius={index === series.length - 1 ? 4 : 0}
              cursor={onBarClick ? 'pointer' : 'default'}
              onMouseEnter={(entry: unknown) => {
                const row = (entry as { payload?: ChartRow } | null)?.payload;
                const box = geometry(entry);
                if (!row || !box) return;
                setHover({ row, ...box, plot: plotArea(box.y) });
                setAnchor(box.centre);
              }}
              onClick={(entry: unknown) => {
                if (!onBarClick) return;
                const row = (entry as { payload?: ChartRow } | null)?.payload;
                if (!row) return;
                const value = Number(row[item.dataKey] ?? 0);
                onBarClick({
                  periodLabel: String(row.label),
                  periodKey: String(row.periodKey),
                  accountId: item.dataKey === 'total' ? undefined : item.dataKey,
                  accountName: item.dataKey === 'total' ? undefined : item.label,
                  value,
                  dataKey: item.dataKey,
                });
              }}
            />
          ))}
          <ChartLegend
            verticalAlign="bottom"
            content={
              <ChartLegendContent
                payload={legendPayload}
                verticalAlign="bottom"
                className="flex-wrap justify-start gap-x-4 gap-y-1"
              />
            }
          />
        </BarChart>

        {/* Column highlight. Recharts' own `cursor` belonged to the Tooltip we no
            longer render, and it is what tells you which column you are on
            before the tooltip paints. It is confined to the plot area and uses
            the host's cursor colour, both of which the first attempt got wrong:
            a full-height `bg-muted/60` wash also covered the axis captions and
            ran under the legend. */}
        {hover && hover.plot.height > 0 && (
          <div
            aria-hidden
            className="pointer-events-none absolute z-10"
            style={{
              left: `${hover.left}px`,
              width: `${hover.width}px`,
              top: `${hover.plot.top}px`,
              height: `${hover.plot.height}px`,
              backgroundColor: 'hsl(var(--muted))',
            }}
          />
        )}

        {hover && (
          <InteractiveTooltip
            hover={anchor === undefined ? hover : { ...hover, centre: anchor }}
            series={series}
            formatValue={formatValue}
            onSelect={onBarClick}
            ref={tooltipRef}
          />
        )}
      </ChartContainer>
    </div>
  );
}

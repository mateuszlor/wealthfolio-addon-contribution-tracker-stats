import React from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
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
  label: string;
  [dataKey: string]: string | number;
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
}

/**
 * Colour for the nth series using the golden angle (≈137.508°).
 *
 * The golden angle is an irrational fraction of 360°, so hues never repeat
 * and each new colour lands in the largest gap on the colour wheel. This
 * gives a pleasant, well-separated sequence for any number of accounts.
 * Index 0 starts at 142° (green, the established contribution colour).
 *
 * Pastel tones: low saturation (35%), higher lightness for a calm, readable
 * chart that works in both light and dark mode without vibrating.
 */
export function seriesColor(index: number): { light: string; dark: string } {
  const hue = (142 + index * 137.508) % 360;
  const sat = 35;
  return {
    light: `hsl(${hue} ${sat}% 52%)`,
    dark: `hsl(${hue} ${sat}% 68%)`,
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
  for (const item of series) {
    const color = seriesColor(series.indexOf(item));
    config[item.dataKey] = {
      label: item.label,
      theme: { light: color.light, dark: color.dark },
    };
  }
  return config;
}

/** The subset of recharts' tooltip entry the formatter reads. */
interface ChartTooltipItem {
  color?: string;
  payload?: { fill?: string };
}

/** Sums the tooltip payload, tolerating absent or non-numeric values. */
function sumOf(payload: unknown): number {
  if (!Array.isArray(payload)) return 0;
  return payload.reduce((sum, item) => {
    const value = Number((item as { value?: unknown } | undefined)?.value ?? 0);
    return sum + (Number.isFinite(value) ? value : 0);
  }, 0);
}

/**
 * Native Wealthfolio chart: the same `ChartContainer` / `ChartTooltipContent`
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
}: ContributionChartProps) {
  if (rows.length === 0 || series.length === 0) return null;

  const stacked = series.length > 1;

  // `ChartLegendContent` reads the swatch colour from the payload item and the
  // label from the chart config by `dataKey`, so both have to be present.
  const legendPayload = series.map((item) => ({
    dataKey: item.dataKey,
    value: item.label,
    color: `var(--color-${item.dataKey})`,
  }));

  return (
    <ChartContainer config={buildConfig(series)} className="w-full h-[280px] aspect-auto">
      <BarChart data={rows} margin={{ left: 4, right: 8, top: 8 }}>
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
        <ChartTooltip
          cursor={{ fill: 'hsl(var(--muted))' }}
          content={
            <ChartTooltipContent
              indicator="dot"
              // `labelKey` is deliberately not set. With it, ChartTooltipContent
              // skips the branch that falls back to the x-axis label and looks up
              // `config[labelKey]` instead, which does not exist - the header then
              // resolves to undefined and labelFormatter renders "undefined".
              labelFormatter={(label, payload) => (
                <div className="flex items-center justify-between gap-6">
                  <span>{String(label ?? '')}</span>
                  {/* With one series the only row already shows the amount, so
                      repeating it in the header is noise. */}
                  {series.length > 1 && (
                    <span className="tabular-nums">{formatValue(sumOf(payload))}</span>
                  )}
                </div>
              )}
              formatter={(value, name, item) => {
                const swatch = (item as ChartTooltipItem)?.color ?? item?.payload?.fill;
                return (
                  <div className="flex w-full items-center justify-between gap-6">
                    <span className="flex items-center gap-1.5">
                      {swatch && (
                        <span
                          className="h-2 w-2 shrink-0 rounded-[2px]"
                          style={{ backgroundColor: swatch }}
                        />
                      )}
                      <span className="text-muted-foreground">{String(name)}</span>
                    </span>
                    <span className="tabular-nums font-medium">{formatValue(Number(value))}</span>
                  </div>
                );
              }}
            />
          }
        />
        {series.map((item, index) => (
          <Bar
            key={item.dataKey}
            dataKey={item.dataKey}
            name={item.label}
            stackId={stacked ? 'contributions' : undefined}
            fill={`var(--color-${item.dataKey})`}
            // Only the topmost segment gets rounded corners, otherwise stacked
            // segments show rounded edges in the middle of the column.
            radius={index === series.length - 1 ? 4 : 0}
          />
        ))}
        {/* Recharts renders its own legend markup unless `content` is supplied, so
            passing `content` avoids a second, unstyled legend on top of this one.

            `nameKey` is deliberately omitted: `ChartLegendContent` looks the label
            up in the chart config under that key, and the config is keyed by
            dataKey. Passing `nameKey="label"` looked up `config["label"]`, which
            does not exist, and rendered empty entries. */}
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
    </ChartContainer>
  );
}
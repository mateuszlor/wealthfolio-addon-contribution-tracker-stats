import React from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  XAxis,
  YAxis,
  type ChartConfig,
} from '@wealthfolio/ui/chart';
import type { Bucket } from '../lib/contributions';

/**
 * `theme` lets `ChartStyle` emit concrete colours per mode, so the bar colour
 * does not depend on `--chart-1` being defined in the sandbox. Routing the colour
 * through a CSS variable left the bars black whenever the token was missing.
 */
const chartConfig = {
  total: {
    label: 'Contributions',
    theme: {
      light: 'hsl(142 64% 34%)',
      dark: 'hsl(142 44% 48%)',
    },
  },
} satisfies ChartConfig;

export interface ContributionChartProps {
  buckets: Bucket[];
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
 * Native Wealthfolio chart: the same `ChartContainer` / `ChartTooltipContent`
 * primitives the spending reports use, so colours follow the host theme.
 */
export function ContributionChart({
  buckets,
  formatValue,
  formatTick,
  hideAxis = false,
}: ContributionChartProps) {
  if (buckets.length === 0) return null;

  return (
    <ChartContainer config={chartConfig} className="w-full h-[280px] aspect-auto">
      <BarChart data={buckets} margin={{ left: 4, right: 8, top: 8 }}>
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
              labelKey="label"
              formatter={(value) => formatValue(Number(value))}
            />
          }
        />
        <Bar dataKey="total" fill="var(--color-total)" radius={4} />
      </BarChart>
    </ChartContainer>
  );
}

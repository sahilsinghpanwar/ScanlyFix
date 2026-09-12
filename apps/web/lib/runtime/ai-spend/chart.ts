import type { HourlySpendBucket } from '@scanlyfix/db';
import { formatUsd } from '../ai-log/summary.ts';

export interface HourlyBarLayout {
  x: number;
  y: number;
  width: number;
  height: number;
  isZero: boolean;
  displayHour: string;
  tooltip: string;
  showLabel: boolean;
  costMicroUsd: number;
  calls: number;
  hour: string;
}

export interface HourlyChartLayout {
  totalWidth: number;
  height: number;
  maxCost: number;
  total24h: number;
  totalCalls: number;
  bars: HourlyBarLayout[];
}

export function formatHourlyTooltip(displayHour: string, costMicroUsd: number, calls: number): string {
  return `${displayHour} UTC: ${formatUsd(costMicroUsd)} (${calls} calls)`;
}

export function computeHourlyChartLayout(
  buckets: HourlySpendBucket[],
  height = 110,
  barWidth = 14,
  gap = 8,
): HourlyChartLayout {
  const maxCost = Math.max(...buckets.map((b) => b.costMicroUsd), 10_000); // minimum $0.01 scale
  const total24h = buckets.reduce((acc, b) => acc + b.costMicroUsd, 0);
  const totalCalls = buckets.reduce((acc, b) => acc + b.calls, 0);
  const totalWidth = buckets.length * (barWidth + gap);

  const bars: HourlyBarLayout[] = buckets.map((b, idx) => {
    const x = idx * (barWidth + gap);
    const barHeight = Math.max(
      b.costMicroUsd > 0 ? 3 : 1,
      ((height - 26) * b.costMicroUsd) / maxCost,
    );
    const y = height - 20 - barHeight;
    const isZero = b.costMicroUsd === 0;
    const hourLabel = new Date(b.timestamp).getUTCHours();
    const displayHour = `${hourLabel.toString().padStart(2, '0')}:00`;
    const tooltip = formatHourlyTooltip(displayHour, b.costMicroUsd, b.calls);
    const showLabel = idx % 4 === 0;

    return {
      x,
      y,
      width: barWidth,
      height: barHeight,
      isZero,
      displayHour,
      tooltip,
      showLabel,
      costMicroUsd: b.costMicroUsd,
      calls: b.calls,
      hour: b.hour,
    };
  });

  return {
    totalWidth,
    height,
    maxCost,
    total24h,
    totalCalls,
    bars,
  };
}

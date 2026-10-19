import type { DailyReadingStatDto } from '@bookr/shared';
import { cn } from '@bookr/ui';
import { formatChartDate, formatChartDuration } from './format';

export interface DailyChartProps {
  daily: DailyReadingStatDto[];
}

/**
 * Thirty CSS bars, no chart library: each bar is a list item with its own
 * accessible name, and the tallest bar owns the full height of the plot.
 */
export function DailyChart({ daily }: DailyChartProps) {
  const max = daily.reduce((value, day) => Math.max(value, day.activeSeconds), 0);

  return (
    <figure className="rounded-lg border border-border bg-surface/80 p-4 sm:p-5">
      <figcaption className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-serif text-base text-ink">最近 30 天</span>
        <span className="text-xs text-muted">每日阅读时长</span>
      </figcaption>

      <ol aria-label="每日阅读时长" className="mt-4 flex h-32 items-end gap-1">
        {daily.map((day, index) => {
          const today = index === daily.length - 1;
          const label = `${formatChartDate(day.date)}，${formatChartDuration(day.activeSeconds)}${
            today ? '，今天' : ''
          }`;
          const height =
            max === 0
              ? 0
              : Math.min(
                  100,
                  Math.max(day.activeSeconds > 0 ? 2 : 0, Math.round((day.activeSeconds / max) * 100)),
                );
          return (
            <li
              key={day.date}
              aria-label={label}
              title={label}
              className="flex h-full min-w-0 flex-1 items-end"
            >
              <span
                aria-hidden="true"
                style={{ height: `${height}%` }}
                className={cn(
                  'w-full rounded-sm motion-safe:transition-[height]',
                  day.qualified ? 'bg-accent' : 'bg-accent/30',
                  today && 'outline outline-1 outline-offset-2 outline-ink/40',
                )}
              />
            </li>
          );
        })}
      </ol>

      <div className="mt-2 flex justify-between text-[11px] text-muted">
        <span>{daily[0] ? formatChartDate(daily[0].date) : ''}</span>
        <span>今天</span>
      </div>
    </figure>
  );
}

import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@bookr/ui';
import { fetchStats, statsQueryKey } from '../../api/stats';
import { messageForApiError } from '../../lib/errorMessages';
import { useOnlineStatus } from '../../lib/useOnlineStatus';
import { DailyChart } from './DailyChart';
import { formatDuration } from './format';

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface/80 px-4 py-3">
      <dt className="text-xs tracking-widest text-muted">{label}</dt>
      <dd className="mt-1 font-serif text-lg text-ink">{value}</dd>
    </div>
  );
}

/** The reading habit page: streak, windows, thirty-day chart and the top book. */
export function StatsPage() {
  const online = useOnlineStatus();
  const statsQuery = useQuery({
    queryKey: statsQueryKey,
    queryFn: fetchStats,
    staleTime: 30_000,
  });
  const stats = statsQuery.data;

  return (
    <div className="mx-auto w-full max-w-4xl">
      <header>
        <h1 className="font-serif text-2xl text-ink">统计</h1>
        <p className="mt-1 text-sm text-muted">你读过的每一段安静时光</p>
      </header>

      {!online && stats ? (
        <p className="mt-4 rounded-lg border border-border bg-paper/60 px-4 py-2 text-xs text-muted">
          离线：显示上次同步的统计
        </p>
      ) : null}

      {statsQuery.isPending ? (
        <p role="status" className="mt-10 text-center text-sm tracking-widest text-muted">
          正在翻看阅读记录…
        </p>
      ) : statsQuery.isError || !stats ? (
        <div
          role="alert"
          className="mt-6 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-highlight/40 bg-highlight/5 px-4 py-3 text-sm text-highlight"
        >
          <span>{messageForApiError(statsQuery.error)}</span>
          <Button variant="ghost" size="sm" onClick={() => void statsQuery.refetch()}>
            重试
          </Button>
        </div>
      ) : (
        <>
          <section
            aria-labelledby="stats-streak-title"
            className="mt-5 rounded-lg border border-border bg-surface/80 px-5 py-6"
          >
            <h2 id="stats-streak-title" className="text-xs tracking-widest text-muted">
              连续阅读
            </h2>
            <p className="mt-2 text-ink">
              <span className="font-serif text-4xl leading-none sm:text-5xl">
                {stats.streakDays}
              </span>{' '}
              <span className="text-sm text-muted">天连续阅读</span>
            </p>
            <p className="mt-3 text-xs leading-5 text-muted">
              单日有效阅读满 10 分钟计为一天 · 按 {stats.timezone} 时区统计 ·{' '}
              <Link
                to="/settings"
                className="text-accent underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              >
                修改时区
              </Link>
            </p>
          </section>

          <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-5">
            <StatCard label="今日" value={formatDuration(stats.todaySeconds)} />
            <StatCard label="本周" value={formatDuration(stats.weekSeconds)} />
            <StatCard label="本月" value={formatDuration(stats.monthSeconds)} />
            <StatCard label="累计有效" value={`${stats.effectiveDays} 天`} />
            <StatCard label="读完的书" value={`${stats.finishedBooks} 本`} />
          </dl>

          {stats.effectiveDays === 0 && stats.topBook === null ? (
            <p className="mt-5 rounded-lg border border-dashed border-border bg-paper/40 px-4 py-3 text-sm text-muted">
              打开一本书，读满 10 分钟就会记下第一天。
            </p>
          ) : null}

          <div className="mt-4">
            <DailyChart daily={stats.daily} />
          </div>

          <section
            aria-labelledby="stats-top-book-title"
            className="mt-4 rounded-lg border border-border bg-surface/80 p-4 sm:p-5"
          >
            <h2 id="stats-top-book-title" className="text-xs tracking-widest text-muted">
              最常读的书
            </h2>
            {stats.topBook ? (
              <p className="mt-2 flex flex-wrap items-baseline justify-between gap-2">
                <span className="min-w-0 truncate font-serif text-base text-ink">
                  {stats.topBook.title}
                </span>
                <span className="shrink-0 text-sm text-muted">
                  {formatDuration(stats.topBook.activeSeconds)}
                </span>
              </p>
            ) : (
              <p className="mt-2 text-sm text-muted">还没有最常读的书</p>
            )}
          </section>
        </>
      )}
    </div>
  );
}

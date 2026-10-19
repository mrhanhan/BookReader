import type { AppDeps } from '../app';
import { runMonitorTick } from './check';

/**
 * Runs one monitor pass immediately, then repeats on the configured interval.
 * Ticks never overlap: a slow webhook delays later evaluation instead of
 * stacking concurrent rounds. Returns the stop function used at shutdown.
 */
export function startMonitor(deps: AppDeps): () => void {
  let stopped = false;
  let inFlight = false;

  const tick = async (): Promise<void> => {
    if (stopped || inFlight) {
      return;
    }
    inFlight = true;
    try {
      await runMonitorTick(deps);
    } catch (error) {
      // A monitor failure must never take the server down. The next tick
      // retries with whatever state was persisted. Log only the error name:
      // messages can carry webhook URLs or database connection details.
      console.error(
        '[monitor] tick failed',
        error instanceof Error ? error.name : typeof error,
      );
    } finally {
      inFlight = false;
    }
  };

  void tick();

  const timer = setInterval(() => {
    void tick();
  }, deps.config.alerts.monitorIntervalMs);
  // The monitor must not be the reason the process stays alive in tests.
  timer.unref();

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

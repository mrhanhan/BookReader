import { describe, expect, it } from 'vitest';
import { createReadingClock } from '../readingClock';

/**
 * The clock takes its time source from the caller, so these tests move a
 * plain mutable timestamp instead of faking timers.
 */
function setup(): {
  clock: ReturnType<typeof createReadingClock>;
  setNow: (at: number) => void;
  tickAt: (at: number) => ReturnType<ReturnType<typeof createReadingClock>['tick']>;
} {
  let now = 0;
  const clock = createReadingClock({ now: () => now });
  return {
    clock,
    setNow(at) {
      now = at;
    },
    tickAt(at) {
      now = at;
      return clock.tick();
    },
  };
}

describe('reading clock', () => {
  it('counts active time between a tick and the last activity', () => {
    const { clock, tickAt } = setup();

    clock.activity(0);
    expect(clock.isActive(0)).toBe(true);

    const tick = tickAt(30_000);
    expect(tick.closed).toBeUndefined();
    expect(tick.snapshot).toEqual({
      startedAt: 0,
      endedAt: 30_000,
      activeSeconds: 30,
      pagesRead: 0,
    });
  });

  it('closes at the idle boundary and stops reporting afterwards', () => {
    const { clock, tickAt } = setup();

    clock.activity(0);
    tickAt(30_000);
    const idle = tickAt(120_000);

    expect(idle.snapshot).toBeUndefined();
    expect(idle.closed).toEqual({
      startedAt: 0,
      endedAt: 120_000,
      activeSeconds: 120,
      pagesRead: 0,
    });
    expect(clock.current()).toBeNull();

    const later = tickAt(150_000);
    expect(later.snapshot).toBeUndefined();
    expect(later.closed).toBeUndefined();

    // Activity after the pause opens a new session and credits only new time.
    clock.activity(200_000);
    const restarted = tickAt(210_000);
    expect(restarted.snapshot).toEqual({
      startedAt: 200_000,
      endedAt: 210_000,
      activeSeconds: 10,
      pagesRead: 0,
    });
  });

  it('does not count time while the page is hidden', () => {
    const { clock, tickAt } = setup();

    clock.activity(0);
    expect(tickAt(30_000).snapshot?.activeSeconds).toBe(30);

    clock.setVisible(false, 30_000);
    expect(tickAt(60_000).snapshot).toBeUndefined();
    expect(clock.current()?.activeSeconds).toBe(30);

    clock.setVisible(true, 60_000);
    expect(tickAt(90_000).snapshot?.activeSeconds).toBe(60);
  });

  it('does not count time while the window is blurred', () => {
    const { clock, tickAt } = setup();

    clock.activity(0);
    expect(tickAt(30_000).snapshot?.activeSeconds).toBe(30);

    clock.setFocused(false, 30_000);
    expect(tickAt(60_000).snapshot).toBeUndefined();
    expect(clock.current()?.activeSeconds).toBe(30);

    clock.setFocused(true, 60_000);
    expect(tickAt(90_000).snapshot?.activeSeconds).toBe(60);
  });

  it('rolls over at the maximum segment without losing the last second', () => {
    const { clock, tickAt } = setup();
    const maxSegmentMs = 1_800_000;

    clock.activity(0);
    let rollover: ReturnType<typeof clock.tick> | null = null;
    for (let at = 30_000; at <= maxSegmentMs; at += 30_000) {
      clock.activity(at);
      const tick = tickAt(at);
      if (at === maxSegmentMs) {
        rollover = tick;
      } else {
        expect(tick.closed).toBeUndefined();
      }
    }

    expect(rollover?.snapshot).toBeUndefined();
    expect(rollover?.closed).toEqual({
      startedAt: 0,
      endedAt: maxSegmentMs,
      activeSeconds: 1_800,
      pagesRead: 0,
    });

    // The replacement session starts where the previous one ended.
    expect(clock.current()).toMatchObject({ startedAt: maxSegmentMs, activeSeconds: 0 });
    const next = tickAt(maxSegmentMs + 30_000);
    expect(next.snapshot).toEqual({
      startedAt: maxSegmentMs,
      endedAt: maxSegmentMs + 30_000,
      activeSeconds: 30,
      pagesRead: 0,
    });
  });

  it('restarts the session when the device clock jumps backwards', () => {
    const { clock, tickAt } = setup();

    clock.activity(0);
    expect(tickAt(30_000).snapshot?.activeSeconds).toBe(30);

    // NTP moves the wall clock back ten seconds.
    const jump = tickAt(20_000);
    expect(jump.closed).toEqual({
      startedAt: 0,
      endedAt: 30_000,
      activeSeconds: 30,
      pagesRead: 0,
    });
    expect(clock.current()?.startedAt).toBe(20_000);

    const next = tickAt(50_000);
    expect(next.snapshot).toEqual({
      startedAt: 20_000,
      endedAt: 50_000,
      activeSeconds: 30,
      pagesRead: 0,
    });
  });

  it('close returns the final snapshot and clears the session', () => {
    const { clock } = setup();

    clock.activity(0);
    const final = clock.close(10_000);
    expect(final).toEqual({
      startedAt: 0,
      endedAt: 10_000,
      activeSeconds: 10,
      pagesRead: 0,
    });
    expect(clock.current()).toBeNull();
    expect(clock.close(20_000)).toBeNull();
  });

  it('never reports a session with zero active seconds', () => {
    const { clock, tickAt } = setup();

    clock.activity(0);
    expect(clock.close(0)).toBeNull();
    expect(tickAt(30_000).snapshot).toBeUndefined();
  });

  it('counts page turns and reports them with the next tick', () => {
    const { clock, tickAt } = setup();

    clock.activity(0);
    clock.pageTurn(5_000);
    clock.pageTurn(6_000);

    const tick = tickAt(30_000);
    expect(tick.snapshot).toMatchObject({ activeSeconds: 30, pagesRead: 2 });
  });
});

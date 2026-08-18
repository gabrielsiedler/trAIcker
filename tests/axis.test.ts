import { describe, expect, it } from 'vitest';

import { axisTicks, type AxisTick } from '../src/web/axis.js';

const HOUR = 3_600_000;
const DAY = 86_400_000;

/** Local midnight on a given date, so the tests do not assume a timezone. */
function midnight(year: number, month: number, day: number, hour = 0): number {
  return new Date(year, month - 1, day, hour, 0, 0, 0).getTime();
}

/**
 * The strip stretches one axis over whatever range it is given, so this code
 * has to label two hours and two months with the same call. It cannot be
 * checked by looking at the page: a database only holds as much history as it
 * has, and on the day this shipped that was 28 hours.
 */
describe('axisTicks', () => {
  it('labels a short day by the hour', () => {
    const ticks = axisTicks(midnight(2026, 8, 10, 9), midnight(2026, 8, 10, 17));
    expect(ticks).toHaveLength(9);
    expect(ticks.every((t: AxisTick) => !t.major)).toBe(true);
  });

  it('thins to two-hour steps once a day runs long', () => {
    // 16 hours at one tick per hour is a wall of labels on a 900px chart.
    const ticks = axisTicks(midnight(2026, 8, 10, 7), midnight(2026, 8, 10, 23));
    expect(ticks).toHaveLength(9);
    expect(ticks[1]!.at - ticks[0]!.at).toBe(2 * HOUR);
  });

  it('marks the midnight crossed by a day-and-change range, not just hours', () => {
    // 28 hours stays in the hourly branch, but it still crosses one midnight —
    // that boundary must be visible, not just a wall of HH:MM labels.
    const ticks = axisTicks(midnight(2026, 8, 10, 9), midnight(2026, 8, 11, 13));
    const majors = ticks.filter((t: AxisTick) => t.major);
    expect(majors).toHaveLength(1);
    expect(new Date(majors[0]!.at).getDate()).toBe(11);
    expect(majors[0]!.at).toBe(midnight(2026, 8, 11));
  });

  it('switches to midnights past a day and a half', () => {
    const ticks = axisTicks(midnight(2026, 8, 10, 8), midnight(2026, 8, 13, 20));
    expect(ticks.every((t: AxisTick) => t.major)).toBe(true);
    // The 10th starts mid-morning, so its midnight is before the domain.
    expect(ticks.map((t: AxisTick) => new Date(t.at).getDate())).toEqual([11, 12, 13]);
  });

  it('puts every tick inside the domain', () => {
    const from = midnight(2026, 8, 10, 8);
    const to = midnight(2026, 8, 20, 20);
    for (const tick of axisTicks(from, to)) {
      expect(tick.at).toBeGreaterThanOrEqual(from);
      expect(tick.at).toBeLessThanOrEqual(to);
    }
  });

  it('lands every day tick on local midnight', () => {
    // Stepping the epoch by 86_400_000 would drift by an hour across a DST
    // change and leave every later label at 23:00 or 01:00.
    for (const tick of axisTicks(midnight(2026, 8, 10), midnight(2026, 11, 20))) {
      const d = new Date(tick.at);
      expect([d.getHours(), d.getMinutes()]).toEqual([0, 0]);
    }
  });

  it('keeps the label count readable over a month', () => {
    const ticks = axisTicks(midnight(2026, 7, 1), midnight(2026, 8, 1));
    expect(ticks.length).toBeLessThanOrEqual(18);
    expect(ticks.length).toBeGreaterThan(8);
  });

  it('keeps the label count readable over a year', () => {
    const ticks = axisTicks(midnight(2026, 1, 1), midnight(2026, 12, 31));
    expect(ticks.length).toBeLessThanOrEqual(56);
  });

  it('survives a zero-width domain', () => {
    const at = midnight(2026, 8, 10, 12);
    expect(axisTicks(at, at).length).toBeGreaterThan(0);
  });

  it('spans a fortnight without a gap between labelled days', () => {
    const ticks = axisTicks(midnight(2026, 8, 1), midnight(2026, 8, 15));
    const gaps = ticks.slice(1).map((t: AxisTick, i: number) => t.at - ticks[i]!.at);
    expect(new Set(gaps)).toEqual(new Set([DAY]));
  });
});

import type { Interval } from './types.js';

export const MS_PER_MINUTE = 60_000;
export const MS_PER_DAY = 86_400_000;

/** Parses an ISO 8601 timestamp to epoch ms. Throws on garbage. */
export function toMs(iso: string): number {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) throw new Error(`invalid timestamp: ${iso}`);
  return ms;
}

/** Epoch ms -> ISO 8601 UTC with milliseconds. The canonical storage form. */
export function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

/** Local UTC offset in minutes (e.g. -180 for UTC-3), sign matching ISO 8601. */
export function localOffsetMinutes(at: Date = new Date()): number {
  return -at.getTimezoneOffset();
}

/**
 * The local calendar day (`YYYY-MM-DD`) a UTC instant falls on.
 *
 * The offset is carried per-event rather than read from the current system
 * timezone, so historical data stays correct if you travel or the machine's
 * timezone changes.
 */
export function localDay(utcMs: number, offsetMin: number): string {
  return new Date(utcMs + offsetMin * MS_PER_MINUTE).toISOString().slice(0, 10);
}

/** Epoch ms of local midnight starting the day `utcMs` falls on. */
export function localMidnightBefore(utcMs: number, offsetMin: number): number {
  const shifted = utcMs + offsetMin * MS_PER_MINUTE;
  return Math.floor(shifted / MS_PER_DAY) * MS_PER_DAY - offsetMin * MS_PER_MINUTE;
}

export interface DaySlice extends Interval {
  localDay: string;
}

/**
 * Splits `[start, end)` at every local midnight it crosses.
 *
 * Daily totals are only meaningful if a span that runs from 23:40 to 00:20 is
 * counted as 20 minutes yesterday and 20 minutes today, rather than landing
 * wholly on whichever day happened to win.
 *
 * The offset is held fixed across the split. For a DST-observing timezone that
 * skews the two transition days per year by up to an hour; Brazil no longer
 * observes DST, and the alternative (re-deriving the offset mid-span) adds real
 * complexity for a rounding error.
 */
export function splitAtLocalMidnight(start: number, end: number, offsetMin: number): DaySlice[] {
  if (end <= start) return [];

  const slices: DaySlice[] = [];
  let cursor = start;

  // Guard against a pathological span producing unbounded slices.
  for (let i = 0; i < 400 && cursor < end; i++) {
    const nextMidnight = localMidnightBefore(cursor, offsetMin) + MS_PER_DAY;
    const sliceEnd = Math.min(nextMidnight, end);
    slices.push({ start: cursor, end: sliceEnd, localDay: localDay(cursor, offsetMin) });
    cursor = sliceEnd;
  }

  return slices;
}

/**
 * Merges overlapping and touching intervals into a minimal disjoint set.
 *
 * This is what separates agent wall-clock from agent effort: five subagents
 * running concurrently for an hour is one hour of wall-clock and five hours of
 * effort, and both numbers are worth knowing.
 */
export function mergeIntervals(intervals: readonly Interval[]): Interval[] {
  if (intervals.length === 0) return [];

  const sorted = [...intervals].filter((i) => i.end > i.start).sort((a, b) => a.start - b.start);
  if (sorted.length === 0) return [];

  const merged: Interval[] = [{ ...sorted[0]! }];

  for (let i = 1; i < sorted.length; i++) {
    const current = sorted[i]!;
    const last = merged[merged.length - 1]!;
    if (current.start <= last.end) {
      last.end = Math.max(last.end, current.end);
    } else {
      merged.push({ ...current });
    }
  }

  return merged;
}

/**
 * Removes `cuts` from `base`, splitting where a cut lands in the middle.
 *
 * This is how a hand-logged meeting displaces automatic time: during the half
 * hour you were in a call, that half hour belongs to the call and to nothing
 * else, so the overlapping portion is carved out rather than counted twice.
 */
export function subtractIntervals(base: readonly Interval[], cuts: readonly Interval[]): Interval[] {
  const merged = mergeIntervals(cuts);
  if (merged.length === 0) return base.filter((i) => i.end > i.start).map((i) => ({ ...i }));

  const result: Interval[] = [];

  for (const interval of base) {
    let segments: Interval[] = [{ ...interval }];

    for (const cut of merged) {
      const next: Interval[] = [];
      for (const segment of segments) {
        if (cut.end <= segment.start || cut.start >= segment.end) {
          next.push(segment);
          continue;
        }
        if (cut.start > segment.start) next.push({ start: segment.start, end: cut.start });
        if (cut.end < segment.end) next.push({ start: cut.end, end: segment.end });
      }
      segments = next;
      if (segments.length === 0) break;
    }

    for (const segment of segments) {
      if (segment.end > segment.start) result.push(segment);
    }
  }

  return result;
}

/** Total covered time of a set of intervals, counting overlap only once. */
export function unionDuration(intervals: readonly Interval[]): number {
  return mergeIntervals(intervals).reduce((sum, i) => sum + (i.end - i.start), 0);
}

/** Total time across intervals, counting overlap repeatedly. */
export function sumDuration(intervals: readonly Interval[]): number {
  return intervals.reduce((sum, i) => sum + Math.max(0, i.end - i.start), 0);
}

/** `2h 05m` / `47m` / `38s` — compact enough for a terminal table. */
export function formatDuration(ms: number): string {
  if (ms <= 0) return '0m';
  const totalMinutes = Math.floor(ms / MS_PER_MINUTE);
  if (totalMinutes === 0) return `${Math.round(ms / 1000)}s`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${String(minutes).padStart(2, '0')}m` : `${minutes}m`;
}

/** Decimal hours, rounded to two places — the unit invoices are written in. */
export function toHours(ms: number): number {
  return Math.round((ms / 3_600_000) * 100) / 100;
}

/** Any weekday can open a client's billing week — not just Monday or Sunday. */
export type WeekStart = 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | 'sunday';

export const WEEK_START_DAYS: readonly WeekStart[] = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
];

/** Matches `Date#getUTCDay` (0 = Sunday). */
const WEEK_START_INDEX: Record<WeekStart, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

/**
 * The `YYYY-MM-DD` of the week containing `day`.
 *
 * Weekly caps are contractual, so the week boundary has to match the client's,
 * not the runtime's default — and not every client bills Monday-to-Sunday.
 */
export function weekStart(day: string, startsOn: WeekStart = 'monday'): string {
  const ms = Date.parse(`${day}T00:00:00.000Z`);
  if (!Number.isFinite(ms)) return day;

  const weekday = new Date(ms).getUTCDay(); // 0 = Sunday
  const back = (weekday - WEEK_START_INDEX[startsOn] + 7) % 7;
  return new Date(ms - back * MS_PER_DAY).toISOString().slice(0, 10);
}

/**
 * Rounds a duration to a timesheet increment.
 *
 * Days are rounded individually because that is what gets typed into the form;
 * the weekly figure is the sum of the rounded days, not the rounded sum, so the
 * total always matches what the client sees line by line.
 */
export function roundToIncrement(ms: number, incrementMinutes: number): number {
  if (incrementMinutes <= 0) return ms;
  const increment = incrementMinutes * MS_PER_MINUTE;
  return Math.round(ms / increment) * increment;
}

/** Inclusive list of `YYYY-MM-DD` strings between two local days. */
export function dayRange(fromDay: string, toDay: string): string[] {
  const days: string[] = [];
  let cursor = Date.parse(`${fromDay}T00:00:00.000Z`);
  const end = Date.parse(`${toDay}T00:00:00.000Z`);
  if (!Number.isFinite(cursor) || !Number.isFinite(end)) return days;

  while (cursor <= end && days.length < 3660) {
    days.push(new Date(cursor).toISOString().slice(0, 10));
    cursor += MS_PER_DAY;
  }

  return days;
}

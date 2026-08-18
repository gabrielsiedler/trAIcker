import { localTime } from './api.js';

const MIN_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** Beyond this the axis switches from hour ticks to day boundaries entirely. */
const MULTI_DAY_MS = 36 * HOUR_MS;

/**
 * The tick spacing below the day-boundary threshold, chosen so a zoomed-in
 * view never goes unlabelled — the strip can be zoomed down to a couple of
 * minutes, and an axis stuck at hour ticks would show nothing on it. Each
 * step divides evenly into a day, so it always lands exactly on a midnight
 * rather than drifting past one.
 */
function stepFor(spanMs: number): number {
  if (spanMs > 12 * HOUR_MS) return 2 * HOUR_MS;
  if (spanMs > 4 * HOUR_MS) return HOUR_MS;
  if (spanMs > 90 * MIN_MS) return 30 * MIN_MS;
  if (spanMs > 40 * MIN_MS) return 15 * MIN_MS;
  if (spanMs > 12 * MIN_MS) return 5 * MIN_MS;
  return MIN_MS;
}

export interface AxisTick {
  at: number;
  label: string;
  /** A midnight, drawn heavier — on a long axis it is the only orientation. */
  major: boolean;
}

function dayLabel(at: number): string {
  return new Date(at).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' });
}

/** Local midnights the domain crosses, at or after domainStart. */
function midnightsIn(domainStart: number, domainEnd: number): number[] {
  const cursor = new Date(domainStart);
  cursor.setHours(0, 0, 0, 0);
  if (cursor.getTime() < domainStart) cursor.setDate(cursor.getDate() + 1);

  const midnights: number[] = [];
  for (let m = cursor.getTime(); m <= domainEnd; m += DAY_MS) midnights.push(m);
  return midnights;
}

/**
 * Ticks for a domain of any width.
 *
 * The strip stretches its axis to whatever range it is given, so the same code
 * has to label two hours and two months. An hour tick every hour across a week
 * is 168 unreadable labels; past a day and a half the axis marks midnights
 * instead, and past a fortnight it thins those out too.
 *
 * Below that threshold the axis is still hour ticks, but a range of a day or
 * two still crosses a midnight — and without a marker there, the hour labels
 * alone give no way to tell where one day stops and the next starts. So every
 * midnight the domain crosses always gets a major tick, in both branches.
 *
 * Lives outside the component because it is the part that cannot be checked by
 * looking at the page — a database only holds as much history as it has.
 */
export function axisTicks(domainStart: number, domainEnd: number): AxisTick[] {
  const span = Math.max(domainEnd - domainStart, MIN_MS);
  const ticks: AxisTick[] = [];

  if (span > MULTI_DAY_MS) {
    // Step in whole days, but keep the count readable on a long range.
    const midnights = midnightsIn(domainStart, domainEnd);
    const days = Math.ceil(span / DAY_MS);
    const step = days > 45 ? 7 : days > 14 ? 2 : 1;
    midnights.forEach((m, i) => {
      if (i % step === 0) ticks.push({ at: m, label: dayLabel(m), major: true });
    });
    return ticks;
  }

  const step = stepFor(span);
  const midnights = new Set(midnightsIn(domainStart, domainEnd));
  // Aligned to round numbers (every step divides a day evenly), not to
  // wherever the view happens to start — a zoomed-in pan would otherwise
  // label times like 14:07 instead of 14:05.
  const first = Math.ceil(domainStart / step) * step;

  for (let t = first; t <= domainEnd; t += step) {
    if (midnights.has(t)) {
      ticks.push({ at: t, label: dayLabel(t), major: true });
      midnights.delete(t);
    } else {
      ticks.push({ at: t, label: localTime(new Date(t).toISOString()), major: false });
    }
  }
  // The step doesn't always land exactly on midnight (e.g. a domain starting
  // mid-step) — add any that were missed so a day boundary is never silently
  // skipped.
  for (const m of midnights) ticks.push({ at: m, label: dayLabel(m), major: true });

  ticks.sort((a, b) => a.at - b.at);
  return ticks;
}

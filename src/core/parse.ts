import { MS_PER_DAY, MS_PER_MINUTE, localDay, localOffsetMinutes } from './time.js';

/**
 * Parsers for hand-entered time.
 *
 * Logging a meeting after the fact should cost one line, so these accept the
 * shapes a person actually types rather than one canonical format.
 */

/** `14:00`, `1400`, `2pm`, `2:30pm` -> minutes since local midnight. */
export function parseTimeOfDay(input: string): number | null {
  const value = input.trim().toLowerCase();

  const suffixed = /^(\d{1,2})(?::?(\d{2}))?\s*(am|pm)$/.exec(value);
  if (suffixed) {
    let hours = Number(suffixed[1]);
    const minutes = Number(suffixed[2] ?? '0');
    if (hours > 12 || minutes > 59) return null;
    if (suffixed[3] === 'pm' && hours !== 12) hours += 12;
    if (suffixed[3] === 'am' && hours === 12) hours = 0;
    return hours * 60 + minutes;
  }

  const colon = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (colon) {
    const hours = Number(colon[1]);
    const minutes = Number(colon[2]);
    return hours <= 23 && minutes <= 59 ? hours * 60 + minutes : null;
  }

  const compact = /^(\d{3,4})$/.exec(value);
  if (compact) {
    const raw = compact[1]!.padStart(4, '0');
    const hours = Number(raw.slice(0, 2));
    const minutes = Number(raw.slice(2));
    return hours <= 23 && minutes <= 59 ? hours * 60 + minutes : null;
  }

  return null;
}

/** `30m`, `1h`, `1h30m`, `1.5h`, `90` (bare number means minutes). */
export function parseDuration(input: string): number | null {
  const value = input.trim().toLowerCase();

  const combined = /^(?:(\d+(?:\.\d+)?)\s*h)?\s*(?:(\d+)\s*m(?:in)?)?$/.exec(value);
  if (combined && (combined[1] || combined[2])) {
    const hours = combined[1] ? Number(combined[1]) : 0;
    const minutes = combined[2] ? Number(combined[2]) : 0;
    const total = Math.round(hours * 60 + minutes);
    return total > 0 ? total : null;
  }

  const bare = /^(\d+(?:\.\d+)?)$/.exec(value);
  if (bare) {
    const total = Math.round(Number(bare[1]));
    return total > 0 ? total : null;
  }

  return null;
}

/** `2026-08-10`, `today`, `yesterday`. */
export function parseDay(input: string, now = Date.now()): string | null {
  const value = input.trim().toLowerCase();
  const offset = localOffsetMinutes();

  if (value === 'today') return localDay(now, offset);
  if (value === 'yesterday') return localDay(now - MS_PER_DAY, offset);
  if (/^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00.000Z`))) return value;

  return null;
}

/**
 * Combines a local day and a time of day into a UTC instant.
 *
 * The offset is taken as given rather than from the day itself, so an entry
 * logged from a different timezone still lands where it belongs.
 */
export function toUtc(day: string, minutesOfDay: number, offsetMin: number): number {
  return Date.parse(`${day}T00:00:00.000Z`) + minutesOfDay * MS_PER_MINUTE - offsetMin * MS_PER_MINUTE;
}

import { describe, expect, it } from 'vitest';

import { weekStart } from '../src/core/time.js';

describe('weekStart', () => {
  it('anchors to Monday by default', () => {
    // 2026-08-12 is a Wednesday.
    expect(weekStart('2026-08-12')).toBe('2026-08-10');
  });

  it('anchors to Sunday', () => {
    expect(weekStart('2026-08-12', 'sunday')).toBe('2026-08-09');
  });

  it('anchors to an arbitrary weekday, e.g. a Thursday-to-Wednesday client week', () => {
    // A client billed Thursday-to-Wednesday: 2026-08-06 (Thu) through 2026-08-12 (Wed).
    expect(weekStart('2026-08-06', 'thursday')).toBe('2026-08-06');
    expect(weekStart('2026-08-12', 'thursday')).toBe('2026-08-06');
    // The next day rolls into the following week.
    expect(weekStart('2026-08-13', 'thursday')).toBe('2026-08-13');
  });

  it('returns the day itself when it is the anchor weekday', () => {
    expect(weekStart('2026-08-12', 'wednesday')).toBe('2026-08-12');
  });
});

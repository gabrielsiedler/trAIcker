import { describe, expect, it } from 'vitest';

import { computeFocusSpans } from '../src/aggregate/focus.js';
import type { EventRow } from '../src/core/types.js';

const TZ = -180; // UTC-3
const MIN = 60_000;

let nextId = 1;

/** Builds a UserPromptSubmit row. `at` is an ISO instant in UTC. */
function prompt(at: string, projectId: number, sessionId = 's1', title: string | null = null): EventRow {
  return {
    id: nextId++,
    event_uid: `uid-${nextId}`,
    event_type: 'UserPromptSubmit',
    ts_utc: at,
    tz_offset_min: TZ,
    project_id: projectId,
    session_id: sessionId,
    agent_id: null,
    agent_type: null,
    prompt_id: `p${nextId}`,
    reason: null,
    session_title: title,
    prompt_chars: 10,
    prompt_excerpt: null,
    task_id: null,
    task_subject: null,
    duration_ms: null,
    source: 'hook' as const,
    payload_json: '{}',
    ingested_at: at,
  };
}

const NOW = Date.parse('2026-08-10T20:00:00.000Z');
const OPTS = { idleTimeoutMinutes: 15, idleAttributionCapMinutes: 120, now: NOW };

describe('computeFocusSpans', () => {
  it('gives each interval to the project that received the prompt', () => {
    const { spans } = computeFocusSpans(
      [
        prompt('2026-08-10T12:00:00.000Z', 1),
        prompt('2026-08-10T12:10:00.000Z', 2),
        prompt('2026-08-10T12:15:00.000Z', 1),
      ],
      { ...OPTS, now: Date.parse('2026-08-10T12:20:00.000Z') },
    );

    expect(spans.map((s) => [s.project_id, s.duration_ms / MIN])).toEqual([
      [1, 10],
      [2, 5],
      [1, 5],
    ]);
  });

  it('never lets two projects hold focus at the same instant', () => {
    const { spans } = computeFocusSpans(
      [
        prompt('2026-08-10T12:00:00.000Z', 1),
        prompt('2026-08-10T12:03:00.000Z', 2),
        prompt('2026-08-10T12:04:00.000Z', 3),
        prompt('2026-08-10T12:09:00.000Z', 1),
      ],
      { ...OPTS, now: Date.parse('2026-08-10T12:10:00.000Z') },
    );

    const sorted = [...spans].sort((a, b) => Date.parse(a.start_utc) - Date.parse(b.start_utc));
    for (let i = 1; i < sorted.length; i++) {
      expect(Date.parse(sorted[i]!.start_utc)).toBeGreaterThanOrEqual(Date.parse(sorted[i - 1]!.end_utc));
    }
  });

  it('caps an interval at the idle timeout and records the discarded time', () => {
    const { spans, idleDrops } = computeFocusSpans(
      [prompt('2026-08-10T12:00:00.000Z', 1), prompt('2026-08-10T14:00:00.000Z', 1)],
      { ...OPTS, now: Date.parse('2026-08-10T14:05:00.000Z') },
    );

    expect(spans[0]!.duration_ms).toBe(15 * MIN);
    expect(spans[0]!.truncated_by).toBe('idle_timeout');
    // Two hours elapsed, fifteen minutes counted, the rest is dead time.
    expect(idleDrops.reduce((sum, d) => sum + d.ms, 0)).toBe(105 * MIN);
  });

  it('does not report an overnight gap as idle time', () => {
    // Last prompt Monday evening, next one Tuesday morning. Counting the
    // fourteen hours between as "idle" would swamp the real interruptions.
    const { idleDrops } = computeFocusSpans(
      [prompt('2026-08-10T21:00:00.000Z', 1), prompt('2026-08-11T12:00:00.000Z', 1)],
      { ...OPTS, now: Date.parse('2026-08-11T12:05:00.000Z') },
    );

    expect(idleDrops.reduce((sum, d) => sum + d.ms, 0)).toBe(120 * MIN);
  });

  it('does not cap when the next prompt lands inside the timeout', () => {
    const { spans, idleDrops } = computeFocusSpans(
      [prompt('2026-08-10T12:00:00.000Z', 1), prompt('2026-08-10T12:14:00.000Z', 1)],
      { ...OPTS, now: Date.parse('2026-08-10T12:15:00.000Z') },
    );

    expect(spans[0]!.duration_ms).toBe(14 * MIN);
    expect(spans[0]!.truncated_by).toBeNull();
    expect(idleDrops).toHaveLength(0);
  });

  it('marks the trailing interval open and stops it growing past the cap', () => {
    const near = computeFocusSpans([prompt('2026-08-10T19:55:00.000Z', 1)], OPTS);
    expect(near.spans[0]!.duration_ms).toBe(5 * MIN);
    expect(near.spans[0]!.truncated_by).toBe('open');

    const abandoned = computeFocusSpans([prompt('2026-08-10T08:00:00.000Z', 1)], OPTS);
    expect(abandoned.spans[0]!.duration_ms).toBe(15 * MIN);
    expect(abandoned.spans[0]!.truncated_by).toBe('idle_timeout');
  });

  it('splits an interval crossing local midnight across both days', () => {
    // 03:55Z is 00:55 local (UTC-3), so this interval starts before local
    // midnight on the 10th and ends after it.
    const { spans } = computeFocusSpans(
      [prompt('2026-08-11T02:52:00.000Z', 1), prompt('2026-08-11T03:02:00.000Z', 1)],
      { ...OPTS, now: Date.parse('2026-08-11T03:05:00.000Z') },
    );

    expect(spans).toHaveLength(3);
    expect(spans[0]!.local_day).toBe('2026-08-10');
    expect(spans[0]!.duration_ms).toBe(8 * MIN);
    expect(spans[1]!.local_day).toBe('2026-08-11');
    expect(spans[1]!.duration_ms).toBe(2 * MIN);
  });

  it('crosses sessions and projects using the global prompt order', () => {
    const { spans } = computeFocusSpans(
      [
        prompt('2026-08-10T12:00:00.000Z', 1, 'session-a'),
        prompt('2026-08-10T12:04:00.000Z', 2, 'session-b'),
      ],
      { ...OPTS, now: Date.parse('2026-08-10T12:05:00.000Z') },
    );

    // Project 1's focus is ended by a prompt in a *different* session — the
    // mechanism that removes the need for a manual toggle.
    expect(spans[0]!.project_id).toBe(1);
    expect(spans[0]!.duration_ms).toBe(4 * MIN);
  });

  it('labels spans with the session title snapshotted at the prompt', () => {
    const { spans } = computeFocusSpans(
      [
        prompt('2026-08-10T12:00:00.000Z', 1, 's1', 'Refactor auth flow'),
        prompt('2026-08-10T12:05:00.000Z', 1, 's1', 'Fix stripe webhook'),
      ],
      { ...OPTS, now: Date.parse('2026-08-10T12:06:00.000Z') },
    );

    expect(spans.map((s) => s.title)).toEqual(['Refactor auth flow', 'Fix stripe webhook']);
  });

  it('returns nothing for no prompts', () => {
    expect(computeFocusSpans([], OPTS)).toEqual({ spans: [], idleDrops: [] });
  });
});

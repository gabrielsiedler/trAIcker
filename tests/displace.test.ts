import { describe, expect, it } from 'vitest';

import { applyExclusions, applyManualEntries } from '../src/aggregate/displace.js';
import { subtractIntervals } from '../src/core/time.js';
import type { ExcludedSpanRow, Span } from '../src/core/types.js';

const MIN = 60_000;
const BASE = Date.parse('2026-08-10T12:00:00.000Z');
const at = (min: number) => new Date(BASE + min * MIN).toISOString();

function span(bucket: Span['bucket'], source: Span['source'], from: number, to: number, projectId = 1): Span {
  return {
    bucket,
    source,
    project_id: projectId,
    session_id: 's1',
    agent_id: null,
    agent_type: null,
    title: null,
    title_source: 'session_title',
    local_day: '2026-08-10',
    start_utc: at(from),
    end_utc: at(to),
    duration_ms: (to - from) * MIN,
    truncated_by: null,
  };
}

const manual = (from: number, to: number, projectId = 1) => span('focus', 'manual', from, to, projectId);
const mins = (spans: Span[]) => spans.map((s) => s.duration_ms / MIN);

describe('subtractIntervals', () => {
  it('splits an interval when a cut lands in the middle', () => {
    const result = subtractIntervals([{ start: 0, end: 100 }], [{ start: 40, end: 60 }]);
    expect(result).toEqual([
      { start: 0, end: 40 },
      { start: 60, end: 100 },
    ]);
  });

  it('removes an interval swallowed by a cut', () => {
    expect(subtractIntervals([{ start: 40, end: 60 }], [{ start: 0, end: 100 }])).toEqual([]);
  });

  it('leaves an interval untouched by a disjoint cut', () => {
    expect(subtractIntervals([{ start: 0, end: 10 }], [{ start: 20, end: 30 }])).toEqual([{ start: 0, end: 10 }]);
  });

  it('applies overlapping cuts as one', () => {
    const result = subtractIntervals(
      [{ start: 0, end: 100 }],
      [
        { start: 20, end: 50 },
        { start: 40, end: 70 },
      ],
    );
    expect(result).toEqual([
      { start: 0, end: 20 },
      { start: 70, end: 100 },
    ]);
  });
});

describe('applyManualEntries', () => {
  it('cuts focus on every project, because attention is exclusive', () => {
    // A meeting on project 1 means you were not orchestrating project 2 either.
    const result = applyManualEntries(
      [span('focus', 'prompt_gap', 0, 60, 2)],
      [],
      [manual(10, 40, 1)],
    );

    expect(mins(result.focus)).toEqual([10, 20]);
  });

  it('cuts agent time on the entry own project', () => {
    // Otherwise the same half hour bills twice: once as the meeting, once as
    // that project's occupancy.
    const result = applyManualEntries([], [span('agent', 'subagent', 0, 60, 1)], [manual(10, 40, 1)]);

    expect(mins(result.agent)).toEqual([10, 20]);
  });

  it('leaves agent time on other projects alone — the load-bearing rule', () => {
    // Four agents building another client's API during your call did real work.
    const result = applyManualEntries([], [span('agent', 'subagent', 0, 60, 2)], [manual(10, 40, 1)]);

    expect(mins(result.agent)).toEqual([60]);
  });

  it('removes a span entirely when the entry covers it', () => {
    const result = applyManualEntries(
      [span('focus', 'prompt_gap', 20, 30, 1)],
      [span('agent', 'subagent', 20, 30, 1)],
      [manual(0, 60, 1)],
    );

    expect(result.focus).toHaveLength(0);
    expect(result.agent).toHaveLength(0);
  });

  it('keeps the truncation reason only on the piece that still reaches the end', () => {
    const capped: Span = { ...span('focus', 'prompt_gap', 0, 60, 2), truncated_by: 'idle_timeout' };
    const result = applyManualEntries([capped], [], [manual(10, 40, 1)]);

    expect(result.focus[0]!.truncated_by).toBeNull();
    expect(result.focus[1]!.truncated_by).toBe('idle_timeout');
  });

  it('changes nothing when there are no entries', () => {
    const focus = [span('focus', 'prompt_gap', 0, 60, 1)];
    const agent = [span('agent', 'subagent', 0, 60, 1)];
    const result = applyManualEntries(focus, agent, []);

    expect(result.focus).toEqual(focus);
    expect(result.agent).toEqual(agent);
  });

  it('applies entries from several projects together', () => {
    const result = applyManualEntries(
      [span('focus', 'prompt_gap', 0, 60, 3)],
      [span('agent', 'subagent', 0, 60, 1)],
      [manual(10, 20, 1), manual(30, 40, 2)],
    );

    // Focus loses both windows; agent on project 1 loses only its own.
    expect(mins(result.focus)).toEqual([10, 10, 20]);
    expect(mins(result.agent)).toEqual([10, 40]);
  });
});

function exclusion(from: number, to: number, projectId = 1): ExcludedSpanRow {
  return {
    id: 1,
    project_id: projectId,
    start_utc: at(from),
    end_utc: at(to),
    tz_offset_min: 0,
    note: null,
    created_at: at(0),
  };
}

describe('applyExclusions', () => {
  it('cuts agent time on the exclusion own project', () => {
    // A subagent dispatched into an outage retries under the hood and reports
    // back a duration_ms that covers the whole stretch; this is the correction.
    const result = applyExclusions([span('agent', 'subagent', 0, 60, 1)], [exclusion(10, 40, 1)]);
    expect(mins(result)).toEqual([10, 20]);
  });

  it('leaves agent time on other projects alone', () => {
    const result = applyExclusions([span('agent', 'subagent', 0, 60, 2)], [exclusion(10, 40, 1)]);
    expect(mins(result)).toEqual([60]);
  });

  it('never touches focus', () => {
    // applyExclusions only ever receives the agent array, but the guarantee
    // that matters is that it takes no focus spans as input at all — an
    // exclusion is not a claim about where you were.
    const agentResult = applyExclusions([span('agent', 'main_turn', 0, 60, 1)], [exclusion(0, 60, 1)]);
    expect(agentResult).toHaveLength(0);
  });

  it('changes nothing when there are no exclusions', () => {
    const agent = [span('agent', 'subagent', 0, 60, 1)];
    expect(applyExclusions(agent, [])).toEqual(agent);
  });
});

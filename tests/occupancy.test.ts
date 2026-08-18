import { describe, expect, it } from 'vitest';

import { computeOccupancySpans } from '../src/aggregate/occupancy.js';
import { summarise } from '../src/aggregate/summary.js';
import type { Span } from '../src/core/types.js';

const MIN = 60_000;
const DAY = '2026-08-10';

function span(
  bucket: Span['bucket'],
  source: Span['source'],
  startMin: number,
  endMin: number,
  overrides: Partial<Span> = {},
): Span {
  const base = Date.parse(`${DAY}T12:00:00.000Z`);
  const start = base + startMin * MIN;
  const end = base + endMin * MIN;
  return {
    bucket,
    source,
    project_id: 1,
    session_id: 's1',
    agent_id: null,
    agent_type: null,
    title: null,
    title_source: 'session_title',
    local_day: DAY,
    start_utc: new Date(start).toISOString(),
    end_utc: new Date(end).toISOString(),
    duration_ms: end - start,
    truncated_by: null,
    ...overrides,
  };
}

const OPTS = { stitchGapMinutes: 10 };
const mins = (spans: Span[]) => spans.map((s) => s.duration_ms / MIN);

describe('computeOccupancySpans', () => {
  it('unions focus and agent time without double-counting the overlap', () => {
    // 10 minutes of focus while an agent runs for 30. Naively summing would
    // bill 40 minutes for 30 minutes of wall-clock.
    const result = computeOccupancySpans([span('focus', 'prompt_gap', 0, 10), span('agent', 'subagent', 0, 30)], OPTS);

    expect(mins(result)).toEqual([30]);
  });

  it('bills the full agent run, not just the prompt that started it', () => {
    // The case that motivated this bucket: a prompt kicks off an agent that
    // builds an API for an hour while attention is elsewhere.
    const result = computeOccupancySpans(
      [span('focus', 'prompt_gap', 0, 10), span('agent', 'main_turn', 0, 60), span('agent', 'subagent', 2, 58)],
      OPTS,
    );

    expect(mins(result)).toEqual([60]);
  });

  it('stitches a short gap between an agent finishing and the next prompt', () => {
    const result = computeOccupancySpans([span('agent', 'subagent', 0, 25), span('focus', 'prompt_gap', 30, 45)], OPTS);

    // 5 minutes of reading the output is not a pause in the work.
    expect(mins(result)).toEqual([45]);
  });

  it('splits into separate blocks across a gap longer than the stitch window', () => {
    const result = computeOccupancySpans([span('agent', 'subagent', 0, 25), span('focus', 'prompt_gap', 90, 105)], OPTS);

    expect(mins(result)).toEqual([25, 15]);
  });

  it('lets two projects be occupied at the same time', () => {
    const result = computeOccupancySpans(
      [
        span('agent', 'subagent', 0, 60, { project_id: 1 }),
        span('agent', 'subagent', 0, 60, { project_id: 2, session_id: 's2' }),
      ],
      OPTS,
    );

    expect(result).toHaveLength(2);
    expect(mins(result)).toEqual([60, 60]);
    // Occupancy is not a claim of exclusive attention, so overlap is correct.
    expect(new Set(result.map((s) => s.project_id))).toEqual(new Set([1, 2]));
  });

  it('labels a block with the topic that covers most of it', () => {
    const result = computeOccupancySpans(
      [
        span('focus', 'prompt_gap', 0, 5, { title: 'Quick fix' }),
        span('agent', 'subagent', 5, 55, { title: 'Build payments API' }),
      ],
      OPTS,
    );

    expect(result[0]!.title).toBe('Build payments API');
  });

  it('never folds a previous occupancy pass back into itself', () => {
    const measured = [span('focus', 'prompt_gap', 0, 10), span('agent', 'subagent', 0, 30)];
    const first = computeOccupancySpans(measured, OPTS);
    const second = computeOccupancySpans([...measured, ...first], OPTS);

    expect(mins(second)).toEqual(mins(first));
  });

  it('reports occupancy without inflating focus or effort', () => {
    const measured = [
      span('focus', 'prompt_gap', 0, 10),
      span('agent', 'subagent', 0, 60),
      span('agent', 'subagent', 0, 60, { agent_id: 'a2' }),
    ];
    const all = [...measured, ...computeOccupancySpans(measured, OPTS)];
    const { summaries } = summarise(all, [], []);

    const row = summaries[0]!;
    expect(row.focus_ms).toBe(10 * MIN); // attention is unchanged
    expect(row.agent_wall_ms).toBe(60 * MIN); // union of the two agents
    expect(row.agent_effort_ms).toBe(120 * MIN); // both counted separately
    expect(row.occupancy_ms).toBe(60 * MIN); // what the client is billed
  });
});

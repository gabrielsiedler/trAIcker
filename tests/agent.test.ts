import { describe, expect, it } from 'vitest';

import { computeAgentSpans } from '../src/aggregate/agent.js';
import { summarise } from '../src/aggregate/summary.js';
import type { EventRow, TrackedEvent } from '../src/core/types.js';

const TZ = -180;
const MIN = 60_000;

let nextId = 1;

function event(
  type: TrackedEvent,
  at: string,
  overrides: Partial<EventRow> = {},
): EventRow {
  return {
    id: nextId++,
    event_uid: `uid-${nextId}`,
    event_type: type,
    ts_utc: at,
    tz_offset_min: TZ,
    project_id: 1,
    session_id: 's1',
    agent_id: null,
    agent_type: null,
    prompt_id: null,
    reason: null,
    session_title: null,
    prompt_chars: null,
    prompt_excerpt: null,
    task_id: null,
    task_subject: null,
    duration_ms: null,
    source: 'hook' as const,
    payload_json: '{}',
    ingested_at: at,
    ...overrides,
  };
}

const NOW = Date.parse('2026-08-10T20:00:00.000Z');
const OPTS = { maxTurnMinutes: 120, maxSubagentMinutes: 120, now: NOW };

describe('computeAgentSpans', () => {
  it('builds a subagent span from the tool call duration', () => {
    // The reliable path. SubagentStart never fires, so pairing is impossible;
    // PostToolUse carries the duration and needs no pair.
    const spans = computeAgentSpans(
      [
        event('PostToolUse', '2026-08-10T12:30:00.000Z', {
          agent_id: 'tool-1',
          agent_type: 'Explore',
          duration_ms: 30 * MIN,
        }),
      ],
      OPTS,
    );

    const sub = spans.filter((s) => s.source === 'subagent');
    expect(sub).toHaveLength(1);
    expect(sub[0]!.duration_ms).toBe(30 * MIN);
    expect(sub[0]!.start_utc).toBe('2026-08-10T12:00:00.000Z');
    expect(sub[0]!.agent_type).toBe('Explore');
  });

  it('counts parallel tool subagents separately, restoring leverage', () => {
    // Three agents finishing together after an hour each: one hour of
    // wall-clock, three of effort. Without this the two were always equal.
    const spans = computeAgentSpans(
      [1, 2, 3].map((i) =>
        event('PostToolUse', '2026-08-10T13:00:00.000Z', {
          agent_id: `tool-${i}`,
          agent_type: 'general-purpose',
          duration_ms: 60 * MIN,
        }),
      ),
      OPTS,
    );

    const { summaries } = summarise(spans, [], []);
    expect(summaries[0]!.agent_wall_ms).toBe(60 * MIN);
    expect(summaries[0]!.agent_effort_ms).toBe(180 * MIN);
  });

  it('caps a tool span that exceeds the ceiling', () => {
    const spans = computeAgentSpans(
      [event('PostToolUse', '2026-08-10T18:00:00.000Z', { agent_id: 't1', duration_ms: 300 * MIN })],
      OPTS,
    );

    const sub = spans.find((s) => s.source === 'subagent')!;
    expect(sub.duration_ms).toBe(120 * MIN);
    expect(sub.truncated_by).toBe('max_span');
  });

  it('ignores a tool record with no duration', () => {
    const spans = computeAgentSpans([event('PostToolUse', '2026-08-10T12:30:00.000Z', { agent_id: 't1' })], OPTS);
    expect(spans.filter((s) => s.source === 'subagent')).toHaveLength(0);
  });

  it('does not let a tool record end a main-loop turn', () => {
    const spans = computeAgentSpans(
      [
        event('UserPromptSubmit', '2026-08-10T12:00:00.000Z'),
        event('PostToolUse', '2026-08-10T12:05:00.000Z', { agent_id: 't1', duration_ms: 60_000 }),
        event('Stop', '2026-08-10T12:20:00.000Z'),
      ],
      OPTS,
    );

    expect(spans.find((s) => s.source === 'main_turn')!.duration_ms).toBe(20 * MIN);
  });

  it('pairs a subagent by agent_id', () => {
    const spans = computeAgentSpans(
      [
        event('SubagentStart', '2026-08-10T12:00:00.000Z', { agent_id: 'a1', agent_type: 'Explore' }),
        event('SubagentStop', '2026-08-10T12:30:00.000Z', { agent_id: 'a1', agent_type: 'Explore' }),
      ],
      OPTS,
    );

    const sub = spans.filter((s) => s.source === 'subagent');
    expect(sub).toHaveLength(1);
    expect(sub[0]!.duration_ms).toBe(30 * MIN);
    expect(sub[0]!.agent_type).toBe('Explore');
  });

  it('keeps interleaved subagents apart instead of guessing', () => {
    const spans = computeAgentSpans(
      [
        event('SubagentStart', '2026-08-10T12:00:00.000Z', { agent_id: 'a1' }),
        event('SubagentStart', '2026-08-10T12:05:00.000Z', { agent_id: 'a2' }),
        event('SubagentStop', '2026-08-10T12:40:00.000Z', { agent_id: 'a2' }),
        event('SubagentStop', '2026-08-10T12:50:00.000Z', { agent_id: 'a1' }),
      ],
      OPTS,
    );

    const byAgent = Object.fromEntries(
      spans.filter((s) => s.source === 'subagent').map((s) => [s.agent_id, s.duration_ms / MIN]),
    );
    // Naive nearest-stop pairing would give a1 = 40 and a2 = 45.
    expect(byAgent).toEqual({ a1: 50, a2: 35 });
  });

  it('records every run of a subagent that is launched repeatedly', () => {
    // `agent_id` names the subagent definition, not the run: five launches of
    // the same subagent carry one id. Keying on it kept the first run and threw
    // the rest away, so a session dispatching agents for a quarter of an hour
    // reported as idle — with the hours going unbilled.
    const id = 'ab9-local-dates-68c819cef6493b1d';
    const spans = computeAgentSpans(
      [
        event('SubagentStart', '2026-08-10T12:00:00.000Z', { agent_id: id, agent_type: 'b9-local-dates' }),
        event('SubagentStop', '2026-08-10T12:10:00.000Z', { agent_id: id, agent_type: 'b9-local-dates' }),
        event('SubagentStart', '2026-08-10T12:20:00.000Z', { agent_id: id, agent_type: 'b9-local-dates' }),
        event('SubagentStop', '2026-08-10T12:25:00.000Z', { agent_id: id, agent_type: 'b9-local-dates' }),
        event('SubagentStart', '2026-08-10T12:40:00.000Z', { agent_id: id, agent_type: 'b9-local-dates' }),
        event('SubagentStop', '2026-08-10T12:55:00.000Z', { agent_id: id, agent_type: 'b9-local-dates' }),
      ],
      OPTS,
    );

    const sub = spans.filter((s) => s.source === 'subagent');
    expect(sub.map((s) => s.duration_ms / MIN)).toEqual([10, 5, 15]);
  });

  it('closes the oldest open run when the same subagent overlaps itself', () => {
    // Two runs of one definition in flight at once cannot be told apart. FIFO
    // keeps the count and the total right, which is what gets billed.
    const id = 'ab10-coach-window-582cab6839b434d5';
    const spans = computeAgentSpans(
      [
        event('SubagentStart', '2026-08-10T12:00:00.000Z', { agent_id: id }),
        event('SubagentStart', '2026-08-10T12:05:00.000Z', { agent_id: id }),
        event('SubagentStop', '2026-08-10T12:20:00.000Z', { agent_id: id }),
        event('SubagentStop', '2026-08-10T12:30:00.000Z', { agent_id: id }),
      ],
      OPTS,
    );

    const sub = spans.filter((s) => s.source === 'subagent');
    expect(sub.map((s) => s.duration_ms / MIN)).toEqual([20, 25]);
  });

  it('ignores a stop that has no start open', () => {
    // Seen in the wild: stops carrying an id no start ever used. There is no
    // start to measure from, and inventing one invents billable time.
    const spans = computeAgentSpans(
      [
        event('SubagentStop', '2026-08-10T12:10:00.000Z', { agent_id: 'ac249a3a42050d4b0' }),
        event('SubagentStart', '2026-08-10T12:20:00.000Z', { agent_id: 'a1' }),
        event('SubagentStop', '2026-08-10T12:30:00.000Z', { agent_id: 'a1' }),
      ],
      OPTS,
    );

    const sub = spans.filter((s) => s.source === 'subagent');
    expect(sub).toHaveLength(1);
    expect(sub[0]!.duration_ms).toBe(10 * MIN);
  });

  it('does not count a subagent twice when both signals are present', () => {
    // A build emits the lifecycle or the tool timing. If one ever emitted both,
    // the same run would be measured once from each source.
    const spans = computeAgentSpans(
      [
        event('SubagentStart', '2026-08-10T12:00:00.000Z', { agent_id: 'a1', agent_type: 'Explore' }),
        event('PostToolUse', '2026-08-10T12:30:00.000Z', {
          agent_id: 'a1',
          agent_type: 'Explore',
          duration_ms: 30 * MIN,
        }),
        event('SubagentStop', '2026-08-10T12:30:00.000Z', { agent_id: 'a1', agent_type: 'Explore' }),
      ],
      OPTS,
    );

    const sub = spans.filter((s) => s.source === 'subagent');
    expect(sub).toHaveLength(1);
    expect(sub[0]!.duration_ms).toBe(30 * MIN);
  });

  it('still uses the tool timing for a session with no lifecycle events', () => {
    const spans = computeAgentSpans(
      [
        event('PostToolUse', '2026-08-10T12:30:00.000Z', {
          agent_id: 'a1',
          agent_type: 'Explore',
          duration_ms: 30 * MIN,
        }),
      ],
      OPTS,
    );

    expect(spans.filter((s) => s.source === 'subagent')).toHaveLength(1);
  });

  it('lets parallel subagents overlap freely', () => {
    const spans = computeAgentSpans(
      [
        event('SubagentStart', '2026-08-10T12:00:00.000Z', { agent_id: 'a1' }),
        event('SubagentStart', '2026-08-10T12:00:00.000Z', { agent_id: 'a2' }),
        event('SubagentStart', '2026-08-10T12:00:00.000Z', { agent_id: 'a3' }),
        event('SubagentStop', '2026-08-10T13:00:00.000Z', { agent_id: 'a1' }),
        event('SubagentStop', '2026-08-10T13:00:00.000Z', { agent_id: 'a2' }),
        event('SubagentStop', '2026-08-10T13:00:00.000Z', { agent_id: 'a3' }),
      ],
      OPTS,
    );

    const { summaries } = summarise(spans, [], []);
    // One hour of wall-clock, three hours of autonomous work.
    expect(summaries[0]!.agent_wall_ms).toBe(60 * MIN);
    expect(summaries[0]!.agent_effort_ms).toBe(180 * MIN);
  });

  it('closes an orphaned subagent at SessionEnd', () => {
    const spans = computeAgentSpans(
      [
        event('SubagentStart', '2026-08-10T12:00:00.000Z', { agent_id: 'a1' }),
        event('SessionEnd', '2026-08-10T12:20:00.000Z'),
      ],
      OPTS,
    );

    const sub = spans.find((s) => s.source === 'subagent')!;
    expect(sub.duration_ms).toBe(20 * MIN);
    expect(sub.truncated_by).toBe('max_span');
  });

  it('caps a subagent that never stopped and had no SessionEnd', () => {
    const spans = computeAgentSpans([event('SubagentStart', '2026-08-10T08:00:00.000Z', { agent_id: 'a1' })], OPTS);

    const sub = spans.find((s) => s.source === 'subagent')!;
    expect(sub.duration_ms).toBe(120 * MIN);
    expect(sub.truncated_by).toBe('max_span');
  });

  it('stops an unclosed turn where the session went quiet', () => {
    // A lost Stop must not accrue billable time up to the ceiling. The
    // transcript's last write is the last instant anything really happened.
    const wentQuiet = Date.parse('2026-08-10T12:20:00.000Z');
    const spans = computeAgentSpans([event('UserPromptSubmit', '2026-08-10T12:00:00.000Z')], {
      ...OPTS,
      liveness: new Map([['s1', wentQuiet]]),
    });

    const turn = spans.find((s) => s.source === 'main_turn')!;
    // 20 minutes of work plus the grace, not the 2 hours the ceiling allows.
    expect(turn.duration_ms).toBe(22 * MIN);
    expect(turn.truncated_by).toBe('open');
  });

  it('lets an unclosed turn keep running while the session is alive', () => {
    const spans = computeAgentSpans([event('UserPromptSubmit', '2026-08-10T19:30:00.000Z')], {
      ...OPTS,
      liveness: new Map([['s1', NOW]]),
    });

    expect(spans.find((s) => s.source === 'main_turn')!.duration_ms).toBe(30 * MIN);
  });

  it('keeps a working subagent running even though the transcript is quiet', () => {
    // The transcript goes quiet *because* a subagent is working — Claude Code
    // writes nothing to the session while one runs. Treating that silence as
    // death cut a live agent off two minutes in, and the project then read as
    // idle while it was the only one working.
    const wentQuiet = Date.parse('2026-08-10T19:35:00.000Z');
    const spans = computeAgentSpans([event('SubagentStart', '2026-08-10T19:30:00.000Z', { agent_id: 'a1' })], {
      ...OPTS,
      liveness: new Map([['s1', wentQuiet]]),
    });

    const sub = spans.find((s) => s.source === 'subagent')!;
    expect(sub.duration_ms).toBe(30 * MIN); // to now, not to the quiet mark
    expect(sub.truncated_by).toBe('open');
  });

  it('still bounds an unclosed MAIN turn by the transcript going quiet', () => {
    // The opposite case, and the reason the two use different signals: the
    // assistant streams into the transcript while it thinks, so silence there
    // really does mean the turn is over.
    const wentQuiet = Date.parse('2026-08-10T19:35:00.000Z');
    const spans = computeAgentSpans([event('UserPromptSubmit', '2026-08-10T19:30:00.000Z')], {
      ...OPTS,
      liveness: new Map([['s1', wentQuiet]]),
    });

    expect(spans.find((s) => s.source === 'main_turn')!.duration_ms).toBe(7 * MIN);
  });

  it('still caps a subagent whose session died, rather than running forever', () => {
    // Nothing distinguishes "working" from "killed mid-flight", so the ceiling
    // is what bounds the damage — and the span says `open` so it can be told
    // apart from one that was observed to end.
    const spans = computeAgentSpans([event('SubagentStart', '2026-08-10T12:00:00.000Z', { agent_id: 'a1' })], {
      ...OPTS,
      liveness: new Map([['s1', Date.parse('2026-08-10T12:10:00.000Z')]]),
    });

    const sub = spans.find((s) => s.source === 'subagent')!;
    expect(sub.duration_ms).toBe(120 * MIN); // maxSubagentMinutes
    expect(sub.truncated_by).toBe('max_span');
  });

  it('bounds an unclosed subagent by its OWN transcript going quiet, not the parent session', () => {
    // A lost SubagentStop must not accrue billable time up to wall-clock now —
    // the same bug `liveness` fixes for main turns, but keyed by agent_id
    // against the subagent's own file rather than the parent session's, which
    // stays quiet for the subagent's entire run regardless.
    const wentQuiet = Date.parse('2026-08-10T19:41:00.000Z');
    const spans = computeAgentSpans([event('SubagentStart', '2026-08-10T19:30:00.000Z', { agent_id: 'a1' })], {
      ...OPTS,
      liveness: new Map([['s1', NOW]]), // parent session looks alive throughout
      subagentLiveness: new Map([['a1', wentQuiet]]),
    });

    const sub = spans.find((s) => s.source === 'subagent')!;
    // 11 minutes of real work plus the grace, not the 2 hours to `now`.
    expect(sub.duration_ms).toBe(13 * MIN);
    expect(sub.truncated_by).toBe('open');
  });

  it('falls back to now when no subagent transcript is known', () => {
    const spans = computeAgentSpans([event('SubagentStart', '2026-08-10T19:30:00.000Z', { agent_id: 'a1' })], {
      ...OPTS,
      subagentLiveness: new Map(),
    });

    expect(spans.find((s) => s.source === 'subagent')!.duration_ms).toBe(30 * MIN);
  });

  it('falls back to now when no transcript is known', () => {
    const spans = computeAgentSpans([event('UserPromptSubmit', '2026-08-10T19:30:00.000Z')], {
      ...OPTS,
      liveness: new Map(),
    });

    expect(spans.find((s) => s.source === 'main_turn')!.duration_ms).toBe(30 * MIN);
  });

  it('spans a main turn from prompt to Stop', () => {
    const spans = computeAgentSpans(
      [
        event('UserPromptSubmit', '2026-08-10T12:00:00.000Z', { prompt_id: 'p1' }),
        event('Stop', '2026-08-10T12:08:00.000Z'),
      ],
      OPTS,
    );

    const turn = spans.find((s) => s.source === 'main_turn')!;
    expect(turn.duration_ms).toBe(8 * MIN);
    expect(turn.truncated_by).toBeNull();
  });

  it('ends a turn at the next prompt when you interrupt', () => {
    const spans = computeAgentSpans(
      [
        event('UserPromptSubmit', '2026-08-10T12:00:00.000Z', { prompt_id: 'p1' }),
        event('UserPromptSubmit', '2026-08-10T12:03:00.000Z', { prompt_id: 'p2' }),
        event('Stop', '2026-08-10T12:20:00.000Z'),
      ],
      OPTS,
    );

    const turns = spans.filter((s) => s.source === 'main_turn').map((s) => s.duration_ms / MIN);
    // Without this, both turns would run to the same Stop and 17 minutes of
    // wall-clock would be billed twice.
    expect(turns).toEqual([3, 17]);
  });

  it('does not create a main turn for a subagent prompt', () => {
    const spans = computeAgentSpans(
      [
        event('UserPromptSubmit', '2026-08-10T12:00:00.000Z', { agent_id: 'a1' }),
        event('Stop', '2026-08-10T12:10:00.000Z'),
      ],
      OPTS,
    );

    expect(spans.filter((s) => s.source === 'main_turn')).toHaveLength(0);
  });

  it('inherits the topic of the prompt that was in flight', () => {
    const spans = computeAgentSpans(
      [
        event('UserPromptSubmit', '2026-08-10T12:00:00.000Z', { session_title: 'Fix stripe webhook' }),
        event('SubagentStart', '2026-08-10T12:01:00.000Z', { agent_id: 'a1' }),
        event('SubagentStop', '2026-08-10T12:09:00.000Z', { agent_id: 'a1' }),
      ],
      OPTS,
    );

    expect(spans.find((s) => s.source === 'subagent')!.title).toBe('Fix stripe webhook');
  });

  it('splits a long-running agent span across local midnight', () => {
    const spans = computeAgentSpans(
      [
        event('SubagentStart', '2026-08-11T02:30:00.000Z', { agent_id: 'a1' }),
        event('SubagentStop', '2026-08-11T03:30:00.000Z', { agent_id: 'a1' }),
      ],
      { ...OPTS, now: Date.parse('2026-08-11T04:00:00.000Z') },
    );

    const sub = spans.filter((s) => s.source === 'subagent');
    expect(sub.map((s) => [s.local_day, s.duration_ms / MIN])).toEqual([
      ['2026-08-10', 30],
      ['2026-08-11', 30],
    ]);
  });

  it('lets different projects run agents at the same time', () => {
    const spans = computeAgentSpans(
      [
        event('SubagentStart', '2026-08-10T12:00:00.000Z', { agent_id: 'a1', project_id: 1, session_id: 'sa' }),
        event('SubagentStart', '2026-08-10T12:00:00.000Z', { agent_id: 'a2', project_id: 2, session_id: 'sb' }),
        event('SubagentStop', '2026-08-10T13:00:00.000Z', { agent_id: 'a1', project_id: 1, session_id: 'sa' }),
        event('SubagentStop', '2026-08-10T13:00:00.000Z', { agent_id: 'a2', project_id: 2, session_id: 'sb' }),
      ],
      OPTS,
    );

    const { summaries } = summarise(spans, [], []);
    expect(summaries.map((s) => [s.project_id, s.agent_wall_ms / MIN]).sort()).toEqual([
      [1, 60],
      [2, 60],
    ]);
  });
});

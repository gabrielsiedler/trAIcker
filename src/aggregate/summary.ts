import { toMs, unionDuration } from '../core/time.js';
import type { EventRow, Interval, Span, TitleSource } from '../core/types.js';
import type { IdleDrop } from './focus.js';
import { labelFor, type TaskIndex } from './tasks.js';

/** Label used when neither a session title nor a prompt excerpt is available. */
export const UNTITLED = '(untitled)';

export interface DailySummaryRow {
  local_day: string;
  project_id: number;
  focus_ms: number;
  agent_wall_ms: number;
  agent_effort_ms: number;
  /** Billable wall-clock: union of focus and agent, short gaps stitched. */
  occupancy_ms: number;
  idle_dropped_ms: number;
  prompt_count: number;
  session_count: number;
  subagent_count: number;
}

export interface DailyTopicRow {
  local_day: string;
  project_id: number;
  title: string;
  /** Where the label came from. See `TitleSource`. */
  title_source: TitleSource;
  focus_ms: number;
  agent_wall_ms: number;
  occupancy_ms: number;
  prompt_count: number;
  first_utc: string;
  last_utc: string;
}

interface Accumulator {
  focus_ms: number;
  agent_effort_ms: number;
  occupancy_ms: number;
  agentIntervals: Interval[];
  sessions: Set<string>;
  subagentRuns: number;
}

/**
 * Rolls spans up into the per-day, per-project numbers the reports read.
 *
 * The two agent figures answer different questions and are both kept:
 *
 * - `agent_wall_ms` is the union of agent spans. It can never exceed the day,
 *   and answers "how long was this project warm".
 * - `agent_effort_ms` is the plain sum. It routinely exceeds 24h on a busy day,
 *   and answers "how much autonomous work got done" — the leverage number.
 *
 * `focus_ms` needs no union: focus spans are disjoint by construction.
 */
export function summarise(
  spans: readonly Span[],
  prompts: readonly EventRow[],
  idleDrops: readonly IdleDrop[],
  tasks: TaskIndex | null = null,
): { summaries: DailySummaryRow[]; topics: DailyTopicRow[] } {
  const acc = new Map<string, Accumulator>();

  const bucketFor = (day: string, projectId: number): Accumulator => {
    const key = `${day}|${projectId}`;
    let entry = acc.get(key);
    if (!entry) {
      entry = {
        focus_ms: 0,
        agent_effort_ms: 0,
        occupancy_ms: 0,
        agentIntervals: [],
        sessions: new Set(),
        subagentRuns: 0,
      };
      acc.set(key, entry);
    }
    return entry;
  };

  for (const span of spans) {
    const entry = bucketFor(span.local_day, span.project_id);
    entry.sessions.add(span.session_id);

    if (span.bucket === 'focus') {
      entry.focus_ms += span.duration_ms;
    } else if (span.bucket === 'occupancy') {
      // Occupancy blocks are already disjoint within a project-day, so summing
      // them is the union — no second merge needed.
      entry.occupancy_ms += span.duration_ms;
    } else {
      entry.agent_effort_ms += span.duration_ms;
      entry.agentIntervals.push({ start: toMs(span.start_utc), end: toMs(span.end_utc) });
      // Counted per run, not per agent_id: that id names the subagent
      // definition, so five launches of one agent share it and counting
      // distinct ids reported "2 subagents" for a day that dispatched a dozen.
      if (span.source === 'subagent') entry.subagentRuns++;
    }
  }

  const promptCounts = new Map<string, number>();
  for (const prompt of prompts) {
    const day = new Date(toMs(prompt.ts_utc) + prompt.tz_offset_min * 60_000).toISOString().slice(0, 10);
    const key = `${day}|${prompt.project_id}`;
    promptCounts.set(key, (promptCounts.get(key) ?? 0) + 1);
    bucketFor(day, prompt.project_id).sessions.add(prompt.session_id);
  }

  const dropped = new Map<string, number>();
  for (const drop of idleDrops) {
    const key = `${drop.local_day}|${drop.project_id}`;
    dropped.set(key, (dropped.get(key) ?? 0) + drop.ms);
    bucketFor(drop.local_day, drop.project_id);
  }

  const summaries: DailySummaryRow[] = [];
  for (const [key, entry] of acc) {
    const [day, projectId] = key.split('|') as [string, string];
    summaries.push({
      local_day: day,
      project_id: Number(projectId),
      focus_ms: entry.focus_ms,
      agent_wall_ms: unionDuration(entry.agentIntervals),
      agent_effort_ms: entry.agent_effort_ms,
      occupancy_ms: entry.occupancy_ms,
      idle_dropped_ms: dropped.get(key) ?? 0,
      prompt_count: promptCounts.get(key) ?? 0,
      session_count: entry.sessions.size,
      subagent_count: entry.subagentRuns,
    });
  }

  return { summaries, topics: summariseTopics(spans, prompts, tasks) };
}

/**
 * Same rollup, sliced by what was being worked on.
 *
 * This is the layer that turns a day's total into something you can put on an
 * invoice line: not "4h on client X" but "1h20 on 'refactor auth flow',
 * 50m on 'fix stripe webhook'".
 *
 * Caveat on `occupancy_ms` here: an occupancy block carries a single dominant
 * title, so its whole duration lands on that one topic. The per-topic figures
 * still sum to the day's occupancy, but a topic that never dominated a block
 * can show zero while having real focus time. Rank timesheet descriptions on
 * focus and agent time as well, never on occupancy alone.
 */
function summariseTopics(
  spans: readonly Span[],
  prompts: readonly EventRow[],
  tasks: TaskIndex | null,
): DailyTopicRow[] {
  interface TopicAcc {
    focus_ms: number;
    occupancy_ms: number;
    agentIntervals: Interval[];
    prompt_count: number;
    first: number;
    last: number;
  }

  const acc = new Map<string, TopicAcc>();

  // The source travels on the span, so it is read rather than reconstructed by
  // matching label strings — which was fragile and could not classify a label
  // that no prompt produced, such as a hand-logged meeting note.
  const sources = new Map<string, TitleSource>();
  for (const span of spans) {
    if (span.title !== null && !sources.has(span.title)) sources.set(span.title, span.title_source);
  }
  for (const prompt of prompts) {
    const label = labelFor(prompt, tasks);
    if (label.title && !sources.has(label.title)) sources.set(label.title, label.source);
  }

  const bucketFor = (day: string, projectId: number, title: string, at: number): TopicAcc => {
    const key = `${day}|${projectId}|${title}`;
    let entry = acc.get(key);
    if (!entry) {
      entry = { focus_ms: 0, occupancy_ms: 0, agentIntervals: [], prompt_count: 0, first: at, last: at };
      acc.set(key, entry);
    }
    entry.first = Math.min(entry.first, at);
    entry.last = Math.max(entry.last, at);
    return entry;
  };

  for (const span of spans) {
    const start = toMs(span.start_utc);
    const entry = bucketFor(span.local_day, span.project_id, span.title ?? UNTITLED, start);
    entry.last = Math.max(entry.last, toMs(span.end_utc));
    if (span.bucket === 'focus') entry.focus_ms += span.duration_ms;
    else if (span.bucket === 'occupancy') entry.occupancy_ms += span.duration_ms;
    else entry.agentIntervals.push({ start, end: toMs(span.end_utc) });
  }

  for (const prompt of prompts) {
    const at = toMs(prompt.ts_utc);
    const day = new Date(at + prompt.tz_offset_min * 60_000).toISOString().slice(0, 10);
    const title = prompt.session_title ?? prompt.prompt_excerpt ?? UNTITLED;
    bucketFor(day, prompt.project_id, title, at).prompt_count += 1;
  }

  const rows: DailyTopicRow[] = [];
  for (const [key, entry] of acc) {
    const parts = key.split('|');
    const day = parts[0]!;
    const projectId = Number(parts[1]!);
    // Titles may contain '|', so rejoin everything after the project id.
    const title = parts.slice(2).join('|');
    rows.push({
      local_day: day,
      project_id: projectId,
      title,
      title_source: sources.get(title) ?? 'prompt_excerpt',
      focus_ms: entry.focus_ms,
      agent_wall_ms: unionDuration(entry.agentIntervals),
      occupancy_ms: entry.occupancy_ms,
      prompt_count: entry.prompt_count,
      first_utc: new Date(entry.first).toISOString(),
      last_utc: new Date(entry.last).toISOString(),
    });
  }

  return rows;
}

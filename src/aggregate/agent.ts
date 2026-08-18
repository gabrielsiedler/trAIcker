import { MS_PER_MINUTE, splitAtLocalMidnight, toIso, toMs } from '../core/time.js';
import type { EventRow, Span } from '../core/types.js';
import { labelFor, type TaskIndex } from './tasks.js';

export interface AgentOptions {
  tasks?: TaskIndex | null;
  /**
   * Session id to the last instant that session showed any sign of life.
   *
   * Bounds spans whose closing event never arrived. Without it, one lost `Stop`
   * silently accrues billable time up to the hard ceiling.
   */
  liveness?: Map<string, number> | null;
  /**
   * `agent_id` to the last instant that *specific subagent's own* transcript
   * was written to. See `subagentCeiling` for why this must not be the parent
   * session's liveness.
   */
  subagentLiveness?: Map<string, number> | null;
  maxTurnMinutes: number;
  maxSubagentMinutes: number;
  now: number;
}

/** Grace after the last sign of life, so a live span is not clipped short. */
const LIVENESS_GRACE_MS = 2 * MS_PER_MINUTE;

/**
 * How far an unclosed span may run: to now if the session is still alive, or to
 * shortly after it went quiet if it is not.
 *
 * Liveness is the transcript's mtime, which is a good signal for a main turn —
 * the assistant streams into it while thinking. It is the wrong signal for a
 * subagent; see `subagentCeiling`.
 */
function livenessCeiling(options: AgentOptions, sessionId: string): number {
  const lastSeen = options.liveness?.get(sessionId);
  if (lastSeen === undefined) return options.now;
  return Math.min(options.now, lastSeen + LIVENESS_GRACE_MS);
}

/**
 * How far a subagent that has not reported back may run.
 *
 * Deliberately NOT the *parent session's* transcript mtime. While a subagent
 * works, Claude Code writes nothing to the session transcript — so that file
 * goes quiet precisely *because* an agent is busy, and treating that silence
 * as death cut a live fifteen-minute agent off two minutes after it started.
 *
 * The subagent has its own transcript, though (`agent-<id>.jsonl`), and that
 * one *does* go quiet the moment the run actually ends — crashed, killed, or
 * finished with its `SubagentStop` lost. Bounding on it is what
 * `livenessCeiling` does for main turns; a lost `Stop` used to fall through
 * to wall-clock `now` instead, which is what let one dead subagent make a
 * project look like it was still being worked on hours after it wasn't.
 *
 * No liveness on record for this agent (an older build, or the file already
 * swept away) falls back to `now`, same as before.
 */
function subagentCeiling(options: AgentOptions, agentId: string | null): number {
  const lastSeen = agentId ? options.subagentLiveness?.get(agentId) : undefined;
  if (lastSeen === undefined) return options.now;
  return Math.min(options.now, lastSeen + LIVENESS_GRACE_MS);
}

/**
 * Builds the agent timeline: autonomous work that ran without your attention.
 *
 * Unlike focus, these spans overlap freely — across projects, and within a
 * project. That is the point. Five agents working in parallel is five agents
 * working in parallel, and flattening that would erase the only number that
 * makes this workflow measurable.
 *
 * Two sources, deliberately overlapping:
 *
 * - `subagent`: SubagentStart -> SubagentStop, or the Task tool's own timing.
 * - `main_turn`: UserPromptSubmit -> Stop within one session.
 *
 * A subagent runs *inside* a main turn, so their spans nest. Summarisation
 * therefore reports both a union (wall-clock: how long the project was warm)
 * and a sum (effort: how much autonomous work happened). Neither alone is
 * honest.
 */
export function computeAgentSpans(events: readonly EventRow[], options: AgentOptions): Span[] {
  // A session reports subagents one way or the other: some builds emit the
  // Start/Stop lifecycle, others only a PostToolUse carrying `duration_ms`.
  // While the lifecycle path was broken the overlap was harmless; with it
  // working, running both over the same session counts every subagent twice.
  const withLifecycle = new Set(
    events.filter((e) => e.event_type === 'SubagentStart' && e.agent_id).map((e) => e.session_id),
  );

  return [
    ...computeToolSubagentSpans(
      events.filter((e) => !withLifecycle.has(e.session_id)),
      options,
    ),
    ...computeSubagentSpans(events, options),
    ...computeMainTurnSpans(events, options),
  ];
}

/**
 * Subagent spans taken straight from the Task tool's own timing.
 *
 * This is the reliable path. `SubagentStart` never fires in this build, so a
 * Start/Stop pair can never be formed and every subagent span was silently
 * absent — which is why agent effort came out identical to agent wall-clock and
 * all parallelism vanished from the reports.
 *
 * `PostToolUse` carries `duration_ms`, so the span is simply the window ending
 * at the tool call's completion. Nothing to pair, nothing to guess.
 */
function computeToolSubagentSpans(events: readonly EventRow[], options: AgentOptions): Span[] {
  const spans: Span[] = [];

  for (const event of events) {
    if (event.event_type !== 'PostToolUse') continue;
    if (event.duration_ms === null || event.duration_ms <= 0) continue;

    const end = toMs(event.ts_utc);
    const start = Math.max(end - event.duration_ms, end - options.maxSubagentMinutes * MS_PER_MINUTE);
    if (end <= start) continue;

    const taskLabel = labelAt(options.tasks, event.session_id, start);

    pushSliced(spans, {
      bucket: 'agent',
      source: 'subagent',
      project_id: event.project_id,
      session_id: event.session_id,
      agent_id: event.agent_id,
      agent_type: event.agent_type,
      title: taskLabel,
      title_source: taskLabel ? 'task' : 'session_title',
      truncated: event.duration_ms > options.maxSubagentMinutes * MS_PER_MINUTE ? 'max_span' : null,
      start,
      end,
      offsetMin: event.tz_offset_min,
    });
  }

  return spans;
}

/**
 * Label at an instant, preferring a declared task over the session title.
 *
 * Autonomous work inherits whatever you were on when it started, so a subagent
 * launched during a task is attributed to that task rather than to the session
 * as a whole.
 */
function labelAt(tasks: TaskIndex | null | undefined, sessionId: string, at: number): string | null {
  return tasks?.taskAt(sessionId, at) ?? null;
}

/**
 * Pairs subagent lifecycles.
 *
 * `agent_id` identifies the subagent *definition*, not the run: launching
 * `b9-local-dates` five times in an hour produces five Start/Stop pairs all
 * carrying `ab9-local-dates-68c819cef6493b1d`. Treating that id as a unique key
 * kept only the first run and discarded the rest, so a session that had been
 * dispatching agents for a quarter of an hour reported as idle.
 *
 * So the join is by order, not by identity: within one (session, agent_id),
 * each Stop closes the oldest Start still open. Two runs of the same subagent
 * overlapping in time cannot be told apart, but the count and the total are
 * right either way, and that is what gets billed.
 */
function computeSubagentSpans(events: readonly EventRow[], options: AgentOptions): Span[] {
  const maxMs = options.maxSubagentMinutes * MS_PER_MINUTE;
  const spans: Span[] = [];

  const sessionEnds = new Map<string, number>();
  for (const event of events) {
    if (event.event_type !== 'SessionEnd') continue;
    const at = toMs(event.ts_utc);
    const existing = sessionEnds.get(event.session_id);
    if (existing === undefined || at < existing) sessionEnds.set(event.session_id, at);
  }

  // Events arrive in chronological order, so one pass pairs them.
  const open = new Map<string, EventRow[]>();
  const pairs: Array<{ start: EventRow; stop: EventRow | null }> = [];

  for (const event of events) {
    if (!event.agent_id) continue;

    if (event.event_type === 'SubagentStart') {
      const key = agentKey(event);
      const queue = open.get(key);
      if (queue) queue.push(event);
      else open.set(key, [event]);
    } else if (event.event_type === 'SubagentStop') {
      // A stop with nothing open is an orphan — the run began before this
      // window, or its start was never recorded. There is no start to measure
      // from, so inventing one would invent billable time.
      const started = open.get(agentKey(event))?.shift();
      if (started) pairs.push({ start: started, stop: event });
    }
  }

  for (const queue of open.values()) {
    for (const start of queue) pairs.push({ start, stop: null });
  }

  const titles = titleIndex(events);

  for (const { start: event, stop } of pairs) {
    const start = toMs(event.ts_utc);
    const ceiling = start + maxMs;

    let end: number;
    let truncated: Span['truncated_by'] = null;

    if (stop) {
      end = toMs(stop.ts_utc);
    } else {
      // No stop was ever recorded: the session crashed, was killed, or the
      // agent is still working. Fall back to the session's end, then to now.
      const sessionEnd = sessionEnds.get(event.session_id);
      if (sessionEnd !== undefined && sessionEnd > start) {
        end = sessionEnd;
        truncated = 'max_span';
      } else {
        const alive = subagentCeiling(options, event.agent_id);
        end = Math.min(alive, ceiling);
        truncated = end >= ceiling ? 'max_span' : 'open';
      }
    }

    if (end > ceiling) {
      end = ceiling;
      truncated = 'max_span';
    }
    if (end <= start) continue;

    const taskLabel = labelAt(options.tasks, event.session_id, start);

    pushSliced(spans, {
      bucket: 'agent',
      source: 'subagent',
      project_id: event.project_id,
      session_id: event.session_id,
      agent_id: event.agent_id,
      agent_type: event.agent_type,
      title: taskLabel ?? titles.titleAt(event.session_id, start),
      title_source: taskLabel ? 'task' : 'session_title',
      truncated,
      start,
      end,
      offsetMin: event.tz_offset_min,
    });
  }

  return spans;
}

/**
 * Spans the main loop's own working time: from your prompt to the Stop that
 * ends the turn.
 *
 * A turn also ends at the *next* prompt in the same session. If you interrupt
 * and re-prompt, the original turn is over — crediting it until a Stop that
 * belongs to the replacement would double-count the same wall-clock.
 */
function computeMainTurnSpans(events: readonly EventRow[], options: AgentOptions): Span[] {
  const maxMs = options.maxTurnMinutes * MS_PER_MINUTE;
  const spans: Span[] = [];

  const bySession = new Map<string, EventRow[]>();
  for (const event of events) {
    // Subagent traffic and tool records are handled above; neither bounds a
    // main-loop turn.
    if (event.agent_id || event.event_type === 'PostToolUse') continue;
    const list = bySession.get(event.session_id);
    if (list) list.push(event);
    else bySession.set(event.session_id, [event]);
  }

  for (const sessionEvents of bySession.values()) {
    for (let i = 0; i < sessionEvents.length; i++) {
      const prompt = sessionEvents[i]!;
      if (prompt.event_type !== 'UserPromptSubmit') continue;

      const start = toMs(prompt.ts_utc);
      const ceiling = start + maxMs;

      let end: number | null = null;
      for (let j = i + 1; j < sessionEvents.length; j++) {
        const candidate = sessionEvents[j]!;
        if (
          candidate.event_type === 'Stop' ||
          candidate.event_type === 'SessionEnd' ||
          candidate.event_type === 'UserPromptSubmit'
        ) {
          end = toMs(candidate.ts_utc);
          break;
        }
      }

      let truncated: Span['truncated_by'] = null;
      if (end === null) {
        // No Stop was seen. That means the turn is still running — or its Stop
        // was lost and the turn ended long ago. The transcript tells them apart.
        const alive = livenessCeiling(options, prompt.session_id);
        end = Math.min(alive, ceiling);
        truncated = end >= ceiling ? 'max_span' : 'open';
      }
      if (end > ceiling) {
        end = ceiling;
        truncated = 'max_span';
      }
      if (end <= start) continue;

      const label = labelFor(prompt, options.tasks ?? null);

      pushSliced(spans, {
        bucket: 'agent',
        source: 'main_turn',
        project_id: prompt.project_id,
        session_id: prompt.session_id,
        agent_id: null,
        agent_type: null,
        title: label.title,
        title_source: label.source,
        truncated,
        start,
        end,
        offsetMin: prompt.tz_offset_min,
      });
    }
  }

  return spans;
}

/**
 * Lets a subagent inherit the label of whatever prompt was in flight when it
 * started, so autonomous work is attributed to the same topic as the focus time
 * that triggered it.
 */
function titleIndex(events: readonly EventRow[]) {
  const bySession = new Map<string, Array<{ at: number; title: string | null }>>();

  for (const event of events) {
    if (event.event_type !== 'UserPromptSubmit' || event.agent_id) continue;
    const list = bySession.get(event.session_id) ?? [];
    list.push({ at: toMs(event.ts_utc), title: labelFor(event, null).title });
    bySession.set(event.session_id, list);
  }

  for (const list of bySession.values()) list.sort((a, b) => a.at - b.at);

  return {
    titleAt(sessionId: string, at: number): string | null {
      const list = bySession.get(sessionId);
      if (!list) return null;
      let title: string | null = null;
      for (const entry of list) {
        if (entry.at > at) break;
        title = entry.title;
      }
      return title;
    },
  };
}

interface PendingSpan {
  bucket: Span['bucket'];
  source: Span['source'];
  project_id: number;
  session_id: string;
  agent_id: string | null;
  agent_type: string | null;
  title: string | null;
  title_source: Span['title_source'];
  truncated: Span['truncated_by'];
  start: number;
  end: number;
  offsetMin: number;
}

/** Emits one span row per local day the interval touches. */
function pushSliced(target: Span[], pending: PendingSpan): void {
  for (const slice of splitAtLocalMidnight(pending.start, pending.end, pending.offsetMin)) {
    target.push({
      bucket: pending.bucket,
      source: pending.source,
      project_id: pending.project_id,
      session_id: pending.session_id,
      agent_id: pending.agent_id,
      agent_type: pending.agent_type,
      title: pending.title,
      title_source: pending.title_source,
      local_day: slice.localDay,
      start_utc: toIso(slice.start),
      end_utc: toIso(slice.end),
      duration_ms: slice.end - slice.start,
      truncated_by: slice.end === pending.end ? pending.truncated : null,
    });
  }
}

function agentKey(event: EventRow): string {
  return `${event.session_id}|${event.agent_id}`;
}

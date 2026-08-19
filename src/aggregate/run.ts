import type { TraickerConfig } from '../core/config.js';
import type { Db } from '../core/db.js';
import { setMeta } from '../core/db.js';
import { MS_PER_DAY, MS_PER_MINUTE, localDay, toIso } from '../core/time.js';
import type { EventRow, Span } from '../core/types.js';
import { exclusionsInRange } from '../core/exclude.js';
import { manualEntriesInRange, manualSpans } from '../core/manual.js';
import { sessionLiveness, subagentLiveness } from '../ingest/titles.js';
import { computeAgentSpans } from './agent.js';
import { applyExclusions, applyManualEntries } from './displace.js';
import { computeFocusSpans } from './focus.js';
import { computeOccupancySpans } from './occupancy.js';
import { summarise } from './summary.js';
import { buildTaskIndex } from './tasks.js';

export interface AggregateResult {
  daysRebuilt: string[];
  spansWritten: number;
  eventsConsidered: number;
}

export interface AggregateOptions {
  /**
   * Local days to rebuild. When omitted every day in the database is rebuilt —
   * cheap at personal-tracking volumes, and the safest default after a logic
   * change.
   */
  days?: readonly string[];
  /** Evaluation instant; injected so tests are deterministic. */
  now?: number;
}

/**
 * Recomputes derived tables from `events`.
 *
 * Idempotent by construction, not by bookkeeping: this is a pure function of
 * the event log, and the affected days are deleted and rewritten inside one
 * transaction. Running it a hundred times produces the same rows as running it
 * once, so a cron, a SessionEnd hook and a dashboard request can all trigger it
 * without coordinating.
 */
export function aggregate(db: Db, config: TraickerConfig, options: AggregateOptions = {}): AggregateResult {
  const now = options.now ?? Date.now();

  const targetDays = options.days && options.days.length > 0 ? [...new Set(options.days)].sort() : allDays(db);
  if (targetDays.length === 0) {
    setMeta(db, 'last_aggregate_run_utc', toIso(now));
    return { daysRebuilt: [], spansWritten: 0, eventsConsidered: 0 };
  }

  // A focus interval starting on day D-1 can extend into day D, so events
  // before the earliest rebuilt day must be loaded to reconstruct it. The
  // lookback covers the longest span any rule can produce, plus a day of slack.
  const longestSpanMs =
    Math.max(config.idleTimeoutMinutes, config.maxTurnMinutes, config.maxSubagentMinutes) * MS_PER_MINUTE;
  const lookbackDays = Math.ceil(longestSpanMs / MS_PER_DAY) + 1;
  const earliest = Date.parse(`${targetDays[0]!}T00:00:00.000Z`) - lookbackDays * MS_PER_DAY;

  const events = db
    .prepare('SELECT * FROM events WHERE ts_utc >= ? ORDER BY ts_utc ASC, id ASC')
    .all(toIso(earliest)) as EventRow[];

  const prompts = events.filter((e) => e.event_type === 'UserPromptSubmit' && e.agent_id === null);

  // Built once and shared: task windows are what give labels sub-session
  // granularity, and both bucket builders need the same view of them.
  const tasks = buildTaskIndex(events);

  const manual = manualEntriesInRange(db, earliest, now + MS_PER_DAY);
  const manualFocus = manualSpans(manual);
  const exclusions = exclusionsInRange(db, earliest, now + MS_PER_DAY);

  const focus = computeFocusSpans(prompts, {
    tasks,
    idleTimeoutMinutes: config.idleTimeoutMinutes,
    idleAttributionCapMinutes: config.idleAttributionCapMinutes,
    now,
  });
  const agentSpans = computeAgentSpans(events, {
    tasks,
    liveness: sessionLiveness(),
    subagentLiveness: subagentLiveness(),
    maxTurnMinutes: config.maxTurnMinutes,
    maxSubagentMinutes: config.maxSubagentMinutes,
    now,
  });

  // Spans outside the rebuild window were computed only to get the boundaries
  // right; writing them would clobber days that were not deleted.
  // Hand-logged time displaces what the hooks recorded. A meeting is you,
  // present, on one thing: it ends focus everywhere, and it removes agent time
  // on its own project so the same half hour is not billed twice — once as the
  // meeting and once as occupancy. Agents on *other* projects keep counting,
  // because that work genuinely happened while you were in the call.
  const displaced = applyManualEntries(focus.spans, agentSpans, manualFocus);

  // Corrections come last and touch agent time only: they say a stretch of
  // captured time was never real work (a subagent stuck retrying through an
  // outage, say), not that you were somewhere else. Nothing is added back.
  const correctedAgent = applyExclusions(displaced.agent, exclusions);

  const rebuild = new Set(targetDays);
  const measured = [...displaced.focus, ...manualFocus, ...correctedAgent].filter((s) =>
    rebuild.has(s.local_day),
  );

  // Occupancy is derived from the measured spans, so it is computed after
  // filtering — a block must not be built from days that are not being rebuilt.
  const spans = [
    ...measured,
    ...computeOccupancySpans(measured, { stitchGapMinutes: config.stitchGapMinutes }),
  ];

  const idleDrops = focus.idleDrops.filter((d) => rebuild.has(d.local_day));
  const scopedPrompts = prompts.filter((p) => rebuild.has(localDay(Date.parse(p.ts_utc), p.tz_offset_min)));

  const { summaries, topics } = summarise(spans, scopedPrompts, idleDrops, tasks);

  writeAll(db, targetDays, spans, summaries, topics);
  setMeta(db, 'last_aggregate_run_utc', toIso(now));

  return { daysRebuilt: targetDays, spansWritten: spans.length, eventsConsidered: events.length };
}

function writeAll(
  db: Db,
  days: readonly string[],
  spans: readonly Span[],
  summaries: ReturnType<typeof summarise>['summaries'],
  topics: ReturnType<typeof summarise>['topics'],
): void {
  const deleteSpans = db.prepare('DELETE FROM spans WHERE local_day = ?');
  const deleteSummary = db.prepare('DELETE FROM daily_summary WHERE local_day = ?');
  const deleteTopics = db.prepare('DELETE FROM daily_topics WHERE local_day = ?');

  const insertSpan = db.prepare(
    `INSERT INTO spans (bucket, source, project_id, session_id, agent_id, agent_type, title, title_source,
                        local_day, start_utc, end_utc, duration_ms, truncated_by)
     VALUES (@bucket, @source, @project_id, @session_id, @agent_id, @agent_type, @title, @title_source,
             @local_day, @start_utc, @end_utc, @duration_ms, @truncated_by)`,
  );
  const insertSummary = db.prepare(
    `INSERT INTO daily_summary (local_day, project_id, focus_ms, agent_wall_ms, agent_effort_ms,
                                occupancy_ms, idle_dropped_ms, prompt_count, session_count, subagent_count)
     VALUES (@local_day, @project_id, @focus_ms, @agent_wall_ms, @agent_effort_ms,
             @occupancy_ms, @idle_dropped_ms, @prompt_count, @session_count, @subagent_count)`,
  );
  const insertTopic = db.prepare(
    `INSERT INTO daily_topics (local_day, project_id, title, title_source, focus_ms, agent_wall_ms,
                               occupancy_ms, prompt_count, first_utc, last_utc)
     VALUES (@local_day, @project_id, @title, @title_source, @focus_ms, @agent_wall_ms,
             @occupancy_ms, @prompt_count, @first_utc, @last_utc)`,
  );

  db.transaction(() => {
    for (const day of days) {
      deleteSpans.run(day);
      deleteSummary.run(day);
      deleteTopics.run(day);
    }
    for (const span of spans) insertSpan.run(span);
    for (const summary of summaries) insertSummary.run(summary);
    for (const topic of topics) insertTopic.run(topic);
  })();
}

/** Every local day that has at least one event. */
function allDays(db: Db): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT strftime('%Y-%m-%d', ts_utc, (tz_offset_min || ' minutes')) AS day
       FROM events ORDER BY day`,
    )
    .all() as Array<{ day: string | null }>;

  return rows.map((r) => r.day).filter((d): d is string => typeof d === 'string');
}

import type { Db } from '../core/db.js';
import { MS_PER_DAY, localDay, localOffsetMinutes } from '../core/time.js';

export interface DateRange {
  from: string;
  to: string;
}

export interface ProjectDayRow {
  local_day: string;
  project_id: number;
  project_name: string;
  client: string | null;
  billable: number;
  color: string | null;
  focus_ms: number;
  agent_wall_ms: number;
  agent_effort_ms: number;
  occupancy_ms: number;
  idle_dropped_ms: number;
  prompt_count: number;
  session_count: number;
  subagent_count: number;
}

export interface ProjectTotalRow {
  project_id: number;
  project_name: string;
  client: string | null;
  billable: number;
  color: string | null;
  focus_ms: number;
  agent_wall_ms: number;
  agent_effort_ms: number;
  occupancy_ms: number;
  idle_dropped_ms: number;
  prompt_count: number;
  active_days: number;
  subagent_count: number;
}

export interface TopicRow {
  local_day: string;
  project_id: number;
  project_name: string;
  title: string;
  focus_ms: number;
  agent_wall_ms: number;
  occupancy_ms: number;
  prompt_count: number;
  first_utc: string;
  last_utc: string;
}

export interface TimelineRow {
  bucket: string;
  source: string;
  project_id: number;
  project_name: string;
  /** Carried so the strip can order and filter without a second request. */
  billable: number;
  color: string | null;
  title: string | null;
  agent_type: string | null;
  start_utc: string;
  end_utc: string;
  duration_ms: number;
  truncated_by: string | null;
}

/** Resolves the named ranges the CLI and dashboard both accept. */
export function resolveRange(
  spec: 'today' | 'yesterday' | 'week' | 'month' | 'all',
  now = Date.now(),
): DateRange {
  const offset = localOffsetMinutes();
  const today = localDay(now, offset);

  switch (spec) {
    case 'today':
      return { from: today, to: today };
    case 'yesterday': {
      const day = localDay(now - MS_PER_DAY, offset);
      return { from: day, to: day };
    }
    case 'week':
      return { from: localDay(now - 6 * MS_PER_DAY, offset), to: today };
    case 'month':
      return { from: localDay(now - 29 * MS_PER_DAY, offset), to: today };
    case 'all':
      return { from: '0000-01-01', to: '9999-12-31' };
  }
}

export function projectDays(db: Db, range: DateRange, projectFilter?: string): ProjectDayRow[] {
  return db
    .prepare(
      `SELECT s.local_day, s.project_id, p.name AS project_name, p.client, p.billable, p.color,
              s.focus_ms, s.agent_wall_ms, s.agent_effort_ms, s.occupancy_ms, s.idle_dropped_ms,
              s.prompt_count, s.session_count, s.subagent_count
       FROM daily_summary s
       JOIN projects p ON p.id = s.project_id
       WHERE s.local_day BETWEEN ? AND ?${filterClause(projectFilter)}
       ORDER BY s.local_day DESC, s.focus_ms DESC`,
    )
    .all(...params(range, projectFilter)) as ProjectDayRow[];
}

export function projectTotals(db: Db, range: DateRange, projectFilter?: string): ProjectTotalRow[] {
  return db
    .prepare(
      `SELECT s.project_id, p.name AS project_name, p.client, p.billable, p.color,
              SUM(s.focus_ms)        AS focus_ms,
              SUM(s.agent_wall_ms)   AS agent_wall_ms,
              SUM(s.agent_effort_ms) AS agent_effort_ms,
              SUM(s.occupancy_ms)    AS occupancy_ms,
              SUM(s.idle_dropped_ms) AS idle_dropped_ms,
              SUM(s.prompt_count)    AS prompt_count,
              SUM(s.subagent_count)  AS subagent_count,
              COUNT(DISTINCT s.local_day) AS active_days
       FROM daily_summary s
       JOIN projects p ON p.id = s.project_id
       WHERE s.local_day BETWEEN ? AND ?${filterClause(projectFilter)}
       GROUP BY s.project_id
       ORDER BY focus_ms DESC`,
    )
    .all(...params(range, projectFilter)) as ProjectTotalRow[];
}

export function topics(db: Db, range: DateRange, projectFilter?: string, limit = 40): TopicRow[] {
  return db
    .prepare(
      `SELECT t.local_day, t.project_id, p.name AS project_name, t.title,
              t.focus_ms, t.agent_wall_ms, t.occupancy_ms, t.prompt_count, t.first_utc, t.last_utc
       FROM daily_topics t
       JOIN projects p ON p.id = t.project_id
       WHERE t.local_day BETWEEN ? AND ?${filterClause(projectFilter)}
       ORDER BY t.focus_ms DESC, t.agent_wall_ms DESC
       LIMIT ?`,
    )
    .all(...params(range, projectFilter), limit) as TopicRow[];
}

export interface PromptRow {
  ts_utc: string;
  project_name: string;
  session_id: string;
  label: string | null;
  source: string;
  prompt_chars: number | null;
}

/**
 * One row per prompt — the finest view there is.
 *
 * Deliberately not what `daily_topics` groups by: labelling topics per prompt
 * turns twenty prompts into twenty "topics", which is a prompt log rather than
 * a picture of the day. Sub-session grouping comes from declared tasks; this is
 * for reading back moment to moment.
 */
export function prompts(db: Db, range: DateRange, projectFilter?: string, limit = 200): PromptRow[] {
  return db
    .prepare(
      `SELECT e.ts_utc, p.name AS project_name, e.session_id, e.prompt_chars,
              COALESCE(e.task_subject, e.prompt_excerpt, e.session_title) AS label,
              CASE
                WHEN e.task_subject   IS NOT NULL THEN 'task'
                WHEN e.prompt_excerpt IS NOT NULL THEN 'prompt'
                ELSE 'session'
              END AS source
       FROM events e
       JOIN projects p ON p.id = e.project_id
       WHERE e.event_type = 'UserPromptSubmit'
         AND e.agent_id IS NULL
         AND date(e.ts_utc, (e.tz_offset_min || ' minutes')) BETWEEN ? AND ?
         ${projectFilter ? 'AND (p.name LIKE ? COLLATE NOCASE OR p.path LIKE ? COLLATE NOCASE)' : ''}
       ORDER BY e.ts_utc ASC
       LIMIT ?`,
    )
    .all(...params(range, projectFilter), limit) as PromptRow[];
}

/** Raw spans for a single day — what the dashboard draws as a gantt strip. */
/**
 * Spans across a date range, for the strip.
 *
 * Takes a range rather than a day because the strip stretches its own time axis
 * to whatever it is given: a week arrives as one continuous axis with a lane per
 * project, not seven stacked charts. Stacking by day would multiply projects by
 * days and stop being readable at the second client.
 */
export function timeline(db: Db, range: DateRange, projectFilter?: string): TimelineRow[] {
  return db
    .prepare(
      `SELECT s.bucket, s.source, s.project_id, p.name AS project_name, p.billable, p.color,
              s.title, s.agent_type, s.start_utc, s.end_utc, s.duration_ms, s.truncated_by
       FROM spans s
       JOIN projects p ON p.id = s.project_id
       WHERE s.local_day BETWEEN ? AND ?${filterClause(projectFilter)}
       ORDER BY s.start_utc ASC`,
    )
    .all(...params(range, projectFilter)) as TimelineRow[];
}

/**
 * Matches a project by name or path fragment, case-insensitively, so
 * `--project stripe` finds "Stripe Integration" without exact spelling.
 */
export function filterClause(projectFilter: string | undefined): string {
  return projectFilter ? ' AND (p.name LIKE ? COLLATE NOCASE OR p.path LIKE ? COLLATE NOCASE)' : '';
}

export function params(range: DateRange, projectFilter?: string): unknown[] {
  const base: unknown[] = [range.from, range.to];
  if (projectFilter) base.push(`%${projectFilter}%`, `%${projectFilter}%`);
  return base;
}

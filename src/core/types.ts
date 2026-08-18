/**
 * Shared contracts between the three tiers:
 *
 *   hook.ts  ->  NDJSON spool  ->  ingest  ->  SQLite  ->  aggregate  ->  report
 *
 * `SpoolRecord` is the only type that crosses a process boundary, so it is
 * versioned (`v`) and uses short keys: every byte in a spool line eats into the
 * atomic-append budget that keeps concurrent subagent writes from interleaving.
 * See docs in src/hook.ts for why line size is a correctness concern, not a
 * micro-optimisation.
 */

/** Claude Code hook events trAIcker subscribes to. */
export const TRACKED_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'SubagentStart',
  'SubagentStop',
  'Stop',
  'CwdChanged',
  // Explicit, human-written work boundaries inside a session. The session title
  // is generated once and never changes, so without these a four-hour session
  // that moved through three jobs reports as one topic.
  'TaskCreated',
  'TaskCompleted',
  // Subagent runs, matched to the Task tool only.
  //
  // SubagentStart never fires in this build, so Start/Stop cannot be paired and
  // every subagent span was silently missing — which is why agent effort came
  // out identical to agent wall-clock, erasing all parallelism. This carries
  // `duration_ms`, so the span is derived from the tool call itself and needs
  // no pairing at all.
  'PostToolUse',
] as const;

export type TrackedEvent = (typeof TRACKED_EVENTS)[number];

export function isTrackedEvent(value: unknown): value is TrackedEvent {
  return typeof value === 'string' && (TRACKED_EVENTS as readonly string[]).includes(value);
}

/**
 * One line of the NDJSON spool. Keys are deliberately terse.
 *
 * Free-form text (the prompt body, the assistant's last message) is NEVER
 * written here — only its length. That keeps lines ~200-300 bytes and keeps
 * client content out of the database entirely.
 */
export interface SpoolRecord {
  /** Schema version of this record shape. */
  v: 1;
  /** Event type. */
  e: TrackedEvent;
  /** ISO 8601 UTC with milliseconds. */
  t: string;
  /** Local UTC offset in minutes at capture time (e.g. -180 for UTC-3). */
  tz: number;
  /** Normalised absolute project path. */
  cwd: string;
  /** Claude Code session id. */
  sid: string;
  /** Agent id — null for the main loop, set for subagents. */
  aid: string | null;
  /** Agent type (subagent name), when applicable. */
  at: string | null;
  /** Prompt id, when the event is tied to a turn. */
  pid: string | null;
  /** SessionEnd.reason / SessionStart.source / CwdChanged old_cwd. */
  r: string | null;
  /** Claude Code's auto-generated session title at capture time. */
  ttl: string | null;
  /** Length of the user prompt in characters (UserPromptSubmit only). */
  plen: number | null;
  /** Truncated prompt excerpt, only when session title is unavailable. */
  ex: string | null;
  /** Task id (TaskCreated / TaskCompleted only). */
  tid: string | null;
  /**
   * Task subject. Short by construction, so it does not threaten the line-size
   * invariant; the description is deliberately not captured.
   */
  tsub: string | null;
  /**
   * Tool duration in ms (PostToolUse only).
   *
   * A subagent span derived from this needs no start event, which matters
   * because SubagentStart never arrives.
   */
  dur: number | null;
}

/** A row of `events` as read back from SQLite. */
export interface EventRow {
  id: number;
  event_uid: string;
  event_type: TrackedEvent;
  ts_utc: string;
  tz_offset_min: number;
  project_id: number;
  session_id: string;
  agent_id: string | null;
  agent_type: string | null;
  prompt_id: string | null;
  reason: string | null;
  session_title: string | null;
  prompt_chars: number | null;
  prompt_excerpt: string | null;
  task_id: string | null;
  task_subject: string | null;
  duration_ms: number | null;
  /**
   * `hook` was observed as it happened; `transcript` was reconstructed after
   * the fact to repair a window where capture was broken. Both are real work,
   * but a billing record must be able to tell them apart.
   */
  source: EventSource;
  payload_json: string;
  ingested_at: string;
}

export type EventSource = 'hook' | 'transcript';

/**
 * Where a label came from, best first.
 *
 * `task` is a boundary you declared, so it is the only source with sub-session
 * granularity. `session_title` is clean but generated once per session.
 * `prompt_excerpt` is raw text you typed — fine for your own reports, never for
 * a client's.
 */
export type TitleSource = 'manual' | 'task' | 'session_title' | 'prompt_excerpt';

/** Categories of work that produce no Claude Code events. */
export const MANUAL_KINDS = ['meeting', 'research', 'review', 'admin', 'other'] as const;
export type ManualKind = (typeof MANUAL_KINDS)[number];

export function isManualKind(value: unknown): value is ManualKind {
  return typeof value === 'string' && (MANUAL_KINDS as readonly string[]).includes(value);
}

/**
 * Time you logged by hand: meetings, research, anything off the tools.
 *
 * Kept in its own table rather than in `events` because `events` is an
 * append-only log of what the hooks observed, and aggregation rebuilds from it
 * verbatim. Manual entries are authored, editable and deletable; mixing the two
 * would make "reprocess the history" ambiguous.
 */
export interface ManualEntryRow {
  id: number;
  project_id: number;
  start_utc: string;
  end_utc: string;
  tz_offset_min: number;
  kind: ManualKind;
  note: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * `focus` and `agent` are measurements. `occupancy` is the billable view:
 * the union of the two, answering "how long was this project being worked on,
 * by me or by an agent I directed".
 *
 * Occupancy deliberately overlaps across projects. Running three projects in
 * parallel genuinely does produce more than 24 project-hours in a day; that is
 * the point of the working model, not an error to be normalised away.
 */
export type Bucket = 'focus' | 'agent' | 'occupancy';
export type SpanSource = 'prompt_gap' | 'main_turn' | 'subagent' | 'billable_block' | 'manual';

/**
 * Why a span stopped early.
 * - `idle_timeout`: focus interval was capped because the next prompt was too far away
 * - `max_span`: agent span hit the configured ceiling (crash / never-closed span)
 * - `open`: still running as of the last aggregation
 */
export type TruncationReason = 'idle_timeout' | 'max_span' | 'open';

/** A derived time span. Always contained within a single local day. */
export interface Span {
  bucket: Bucket;
  source: SpanSource;
  project_id: number;
  session_id: string;
  agent_id: string | null;
  agent_type: string | null;
  title: string | null;
  /**
   * Carried on the span rather than re-derived later. Reconstructing it by
   * matching label strings is fragile, and it decides whether a label may reach
   * a client's timesheet.
   */
  title_source: TitleSource;
  local_day: string;
  start_utc: string;
  end_utc: string;
  duration_ms: number;
  truncated_by: TruncationReason | null;
}

export interface ProjectRow {
  id: number;
  path: string;
  /** Case-folded path; project identity lives here, not on `path`. */
  path_key: string;
  name: string;
  client: string | null;
  billable: number;
  /** `#rrggbb`, or null to derive one from the id. */
  color: string | null;
  created_at: string;
}

/** Half-open interval [start, end) in epoch milliseconds. */
export interface Interval {
  start: number;
  end: number;
}

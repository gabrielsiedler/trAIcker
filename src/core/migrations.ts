/**
 * Migrations are inlined as strings rather than shipped as .sql files so that
 * `tsc` output is self-contained — no asset-copy step, no runtime path guessing
 * between `tsx src/...` and `node dist/...`.
 */

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

const M001_INIT = /* sql */ `
-- Identity of a tracked project. Kept separate from events so a project can be
-- renamed or re-assigned to a client without rewriting history.
CREATE TABLE projects (
  id         INTEGER PRIMARY KEY,
  path       TEXT    NOT NULL,          -- display form: absolute, forward slashes
  path_key   TEXT    NOT NULL UNIQUE,   -- case-folded on Windows; identity lives here
  name       TEXT    NOT NULL,
  client     TEXT,
  -- No DEFAULT on purpose: whether a project is billable is a decision, and a
  -- schema default is a second place for that decision to live and drift from
  -- the one in upsertProject. Every insert states it.
  billable   INTEGER NOT NULL,
  created_at TEXT    NOT NULL
);

-- Append-only source of truth. Aggregation never writes here, so the whole
-- history can be reprocessed when the definition of "focus" changes.
CREATE TABLE events (
  id             INTEGER PRIMARY KEY,
  event_uid      TEXT    NOT NULL UNIQUE,  -- dedupe key; makes re-ingestion a no-op
  event_type     TEXT    NOT NULL,
  ts_utc         TEXT    NOT NULL,         -- ISO 8601 UTC with milliseconds
  tz_offset_min  INTEGER NOT NULL,         -- local offset at capture time
  project_id     INTEGER NOT NULL REFERENCES projects(id),
  session_id     TEXT    NOT NULL,
  agent_id       TEXT,                     -- NULL for the main loop
  agent_type     TEXT,
  prompt_id      TEXT,
  reason         TEXT,                     -- SessionEnd.reason / SessionStart.source / old cwd
  session_title  TEXT,                     -- Claude Code's auto title, snapshotted per prompt
  prompt_chars   INTEGER,                  -- prompt length; the text itself is never stored
  prompt_excerpt TEXT,                     -- fallback label only, truncated per config
  payload_json   TEXT    NOT NULL,         -- projected spool record, for reprocessing
  ingested_at    TEXT    NOT NULL
);

CREATE INDEX idx_events_ts      ON events (ts_utc);
CREATE INDEX idx_events_type_ts ON events (event_type, ts_utc);
CREATE INDEX idx_events_sess_ts ON events (session_id, ts_utc);
CREATE INDEX idx_events_agent   ON events (agent_id) WHERE agent_id IS NOT NULL;

-- Derived. Rebuilt per affected local day inside a transaction, so re-running
-- aggregation is idempotent by construction rather than by bookkeeping.
CREATE TABLE spans (
  id           INTEGER PRIMARY KEY,
  bucket       TEXT    NOT NULL,  -- 'focus' | 'agent'
  source       TEXT    NOT NULL,  -- 'prompt_gap' | 'main_turn' | 'subagent'
  project_id   INTEGER NOT NULL REFERENCES projects(id),
  session_id   TEXT    NOT NULL,
  agent_id     TEXT,
  agent_type   TEXT,
  title        TEXT,              -- what was being worked on during this span
  local_day    TEXT    NOT NULL,  -- spans never straddle local midnight
  start_utc    TEXT    NOT NULL,
  end_utc      TEXT    NOT NULL,
  duration_ms  INTEGER NOT NULL,
  truncated_by TEXT               -- NULL | 'idle_timeout' | 'max_span' | 'open'
);

CREATE INDEX idx_spans_day     ON spans (local_day, project_id, bucket);
CREATE INDEX idx_spans_project ON spans (project_id, start_utc);

CREATE TABLE daily_summary (
  local_day       TEXT    NOT NULL,
  project_id      INTEGER NOT NULL REFERENCES projects(id),
  focus_ms        INTEGER NOT NULL,  -- mutually exclusive across projects
  agent_wall_ms   INTEGER NOT NULL,  -- union of agent spans; never exceeds the day
  agent_effort_ms INTEGER NOT NULL,  -- sum of agent spans; counts parallelism
  idle_dropped_ms INTEGER NOT NULL,  -- time cut by the idle timeout
  prompt_count    INTEGER NOT NULL,
  session_count   INTEGER NOT NULL,
  subagent_count  INTEGER NOT NULL,
  PRIMARY KEY (local_day, project_id)
);

CREATE TABLE daily_topics (
  local_day     TEXT    NOT NULL,
  project_id    INTEGER NOT NULL REFERENCES projects(id),
  title         TEXT    NOT NULL,
  focus_ms      INTEGER NOT NULL,
  agent_wall_ms INTEGER NOT NULL,
  prompt_count  INTEGER NOT NULL,
  first_utc     TEXT    NOT NULL,
  last_utc      TEXT    NOT NULL,
  PRIMARY KEY (local_day, project_id, title)
);

-- Read position per spool file. Only complete lines (ending in \\n) are consumed,
-- so a file being appended to by a live session is always safe to read.
CREATE TABLE spool_cursor (
  file_path   TEXT    PRIMARY KEY,
  byte_offset INTEGER NOT NULL,
  line_count  INTEGER NOT NULL DEFAULT 0,
  bad_lines   INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT    NOT NULL
);

CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

const M002_OCCUPANCY = /* sql */ `
-- The billable view: union of focus and agent time per project, with short
-- gaps stitched. Unlike focus_ms this may overlap across projects, and the sum
-- across a day may exceed 24h — running three projects in parallel really does
-- produce more than 24 project-hours.
ALTER TABLE daily_summary ADD COLUMN occupancy_ms INTEGER NOT NULL DEFAULT 0;

-- Same figure sliced by topic, so a timesheet line can carry a description
-- without anyone writing one by hand.
ALTER TABLE daily_topics ADD COLUMN occupancy_ms INTEGER NOT NULL DEFAULT 0;
`;

const M003_TITLE_SOURCE = /* sql */ `
-- Where a topic's label came from. A label derived from the prompt text must
-- never reach a client's timesheet: it is raw, unedited, and often in the wrong
-- language for the audience.
ALTER TABLE daily_topics ADD COLUMN title_source TEXT NOT NULL DEFAULT 'session_title';
`;

const M004_TASKS = /* sql */ `
-- Explicit work boundaries declared inside a session. The generated session
-- title never changes, so tasks are the only source of sub-session granularity.
ALTER TABLE events ADD COLUMN task_id TEXT;
ALTER TABLE events ADD COLUMN task_subject TEXT;

CREATE INDEX idx_events_task ON events (task_id) WHERE task_id IS NOT NULL;
`;

const M005_MANUAL = /* sql */ `
-- Hand-logged time: meetings, research, anything that produces no hook events.
-- Kept out of the events table because that one is an append-only record of
-- what was observed, and aggregation rebuilds from it verbatim; these are
-- authored and editable, and mixing them would make reprocessing ambiguous.
CREATE TABLE manual_entries (
  id            INTEGER PRIMARY KEY,
  project_id    INTEGER NOT NULL REFERENCES projects(id),
  start_utc     TEXT    NOT NULL,
  end_utc       TEXT    NOT NULL,
  tz_offset_min INTEGER NOT NULL,
  kind          TEXT    NOT NULL DEFAULT 'other',
  note          TEXT,
  created_at    TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL
);

CREATE INDEX idx_manual_start   ON manual_entries (start_utc);
CREATE INDEX idx_manual_project ON manual_entries (project_id, start_utc);

-- Where a span's label came from, carried rather than re-derived by matching
-- label strings later.
ALTER TABLE spans ADD COLUMN title_source TEXT NOT NULL DEFAULT 'session_title';
`;

const M006_TOOL_DURATION = /* sql */ `
-- How long a tool call took, from PostToolUse. For the Task tool this is the
-- subagent's whole run, which is the only reliable way to measure one:
-- SubagentStart never fires, so a Start/Stop pair can never be formed.
ALTER TABLE events ADD COLUMN duration_ms INTEGER;
`;

const M007_EVENT_SOURCE = /* sql */ `
-- Where an event came from.
--
-- 'hook' is what Claude Code told us as it happened. 'transcript' is
-- reconstructed after the fact from the session transcript, to repair a window
-- where capture was broken. Both are real work, but only the first was
-- observed — and a billing record has to be able to say which is which.
ALTER TABLE events ADD COLUMN source TEXT NOT NULL DEFAULT 'hook';

CREATE INDEX idx_events_source ON events (source) WHERE source <> 'hook';
`;

const M008_TIMESHEET_TEXT = /* sql */ `
-- Your own wording for a day's timesheet line. Wins over anything generated,
-- because the line is prose a client reads and you get the last word on it.
CREATE TABLE timesheet_notes (
  local_day  TEXT    NOT NULL,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  note       TEXT    NOT NULL,
  created_at TEXT    NOT NULL,
  updated_at TEXT    NOT NULL,
  PRIMARY KEY (local_day, project_id)
);

-- Translation cache, keyed by the exact source string.
--
-- Keyed by content rather than by day or project so each distinct label is
-- translated once and reused forever. That also removes the non-determinism
-- that would otherwise be unacceptable in a billing artefact: the same week
-- re-rendered always produces the same words.
CREATE TABLE translations (
  source_hash TEXT NOT NULL,
  target_lang TEXT NOT NULL,
  source_text TEXT NOT NULL,
  translated  TEXT NOT NULL,
  model       TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (source_hash, target_lang)
);
`;

const M009_DAY_SUMMARY = /* sql */ `
-- A day's description, written once by a model that read the whole day.
--
-- The generated description is a join of session titles, and Claude Code names
-- a session once, from its opening minutes. A day spent on eight tasks inside
-- one long session therefore reports the name of the first one. This table
-- holds the result of asking for a description that accounts for everything
-- that happened, which is a different question than the join can answer.
--
-- Keyed by day and project rather than by content: unlike a translation, the
-- input is a whole day of activity and there is no stable string to hash. It is
-- written only when you press refresh, so the same week re-rendered tomorrow
-- still reads exactly as it did when you submitted it.
CREATE TABLE day_summaries (
  local_day   TEXT    NOT NULL,
  project_id  INTEGER NOT NULL REFERENCES projects(id),
  summary     TEXT    NOT NULL,
  -- What the model was shown, so a line on an invoice can be traced back.
  input_kind  TEXT    NOT NULL,   -- 'titles' | 'excerpts'
  input_count INTEGER NOT NULL,
  model       TEXT    NOT NULL,
  lang        TEXT,
  created_at  TEXT    NOT NULL,
  PRIMARY KEY (local_day, project_id)
);
`;

const M010_PROJECT_COLOUR = /* sql */ `
-- Chosen colour for a project, as #rrggbb.
--
-- Null means "derive one from the id", which is what every project got before
-- this existed. Stored rather than always derived because the derived hue is a
-- function of insertion order: adding a project could recolour an unrelated one
-- you had already learned to recognise.
ALTER TABLE projects ADD COLUMN color TEXT;
`;

const M011_MODEL_USAGE = /* sql */ `
-- Raw per-turn capture, parallel to events: append-only, one row per assistant
-- message read from the session transcript (the hook payload never carries
-- model or token usage, so this is the only source for either). message_id is
-- what the API already guarantees unique, so it is the dedupe key — no
-- synthetic hash needed, unlike event_uid.
--
-- Deliberately its own table rather than columns on spans/daily_summary/
-- daily_topics: those are exactly what the client-facing timesheet queries,
-- and cost must never be reachable from there even by accident.
CREATE TABLE model_usage (
  id                          INTEGER PRIMARY KEY,
  message_id                  TEXT    NOT NULL UNIQUE,
  project_id                  INTEGER NOT NULL REFERENCES projects(id),
  session_id                  TEXT    NOT NULL,
  local_day                   TEXT    NOT NULL,
  ts_utc                      TEXT    NOT NULL,
  model                       TEXT    NOT NULL,
  input_tokens                INTEGER NOT NULL,
  output_tokens               INTEGER NOT NULL,
  cache_creation_input_tokens INTEGER NOT NULL,
  cache_read_input_tokens     INTEGER NOT NULL
);

CREATE INDEX idx_model_usage_day ON model_usage (local_day, project_id, model);

-- Rebuilt per affected day, same idempotent delete-and-rewrite shape as
-- daily_summary. Pure SUMs, no interval merging needed — unlike wall-clock
-- time, spend has no overlap to reconcile.
CREATE TABLE daily_model_usage (
  local_day                   TEXT    NOT NULL,
  project_id                  INTEGER NOT NULL REFERENCES projects(id),
  model                       TEXT    NOT NULL,
  input_tokens                INTEGER NOT NULL,
  output_tokens               INTEGER NOT NULL,
  cache_creation_input_tokens INTEGER NOT NULL,
  cache_read_input_tokens     INTEGER NOT NULL,
  turn_count                  INTEGER NOT NULL,
  PRIMARY KEY (local_day, project_id, model)
);

-- Resumable read position per session transcript, same shape as spool_cursor.
-- Keyed by session_id rather than file path: the transcript index already maps
-- session to file, and session_id is the stable identity used everywhere else.
-- (Superseded by M012 — a session can own more than one transcript file.)
CREATE TABLE usage_cursor (
  session_id  TEXT PRIMARY KEY,
  byte_offset INTEGER NOT NULL,
  updated_at  TEXT    NOT NULL
);
`;

const M012_SUBAGENT_USAGE = /* sql */ `
-- One session can own several transcript files: its own, plus one per subagent
-- it dispatched: <session-id>/subagents/agent-<id>.jsonl. Every subagent
-- line carries the *parent's* id in its own sessionId field, so keying the
-- cursor by session made those files fight over a single byte offset —
-- whichever was read last stranded the others mid-file. The key is now per file:
-- '<session-id>' for the session's own transcript, '<session-id>:agent-<id>'
-- for a subagent's.
--
-- Existing rows keep their meaning as-is: a bare session id is already the new
-- key for the session's own transcript, so the rename alone migrates them and
-- no transcript is re-read from zero.
ALTER TABLE usage_cursor RENAME COLUMN session_id TO transcript_key;
`;

// Version 13 is deliberately not used. A different, since-reverted migration
// briefly held that number during development and was live long enough for a
// running dev instance to apply it and stamp user_version = 13 on a real
// database before the source went back to 12 migrations. Reusing 13 for this
// one would make migrate() skip it forever on that database, since the runner
// only compares version numbers, never migration content. See
// context/decisoes.md, 2026-08-18.
const M014_EXCLUDED_SPANS = /* sql */ `
-- A window where automatic capture is known wrong (e.g. a subagent dispatched
-- into a model outage retries under the hood, then reports back through an
-- ordinary successful tool call whose duration_ms covers the whole stretch).
-- Unlike manual_entries this carves agent time on one project only and adds
-- nothing back: it is a correction to the record, not a category of work.
CREATE TABLE excluded_spans (
  id            INTEGER PRIMARY KEY,
  project_id    INTEGER NOT NULL REFERENCES projects(id),
  start_utc     TEXT    NOT NULL,
  end_utc       TEXT    NOT NULL,
  tz_offset_min INTEGER NOT NULL,
  note          TEXT,
  created_at    TEXT    NOT NULL
);

CREATE INDEX idx_excluded_spans_project ON excluded_spans (project_id, start_utc);
`;

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'init', sql: M001_INIT },
  { version: 2, name: 'occupancy', sql: M002_OCCUPANCY },
  { version: 3, name: 'title_source', sql: M003_TITLE_SOURCE },
  { version: 4, name: 'tasks', sql: M004_TASKS },
  { version: 5, name: 'manual', sql: M005_MANUAL },
  { version: 6, name: 'tool_duration', sql: M006_TOOL_DURATION },
  { version: 7, name: 'event_source', sql: M007_EVENT_SOURCE },
  { version: 8, name: 'timesheet_text', sql: M008_TIMESHEET_TEXT },
  { version: 9, name: 'day_summary', sql: M009_DAY_SUMMARY },
  { version: 10, name: 'project_colour', sql: M010_PROJECT_COLOUR },
  { version: 11, name: 'model_usage', sql: M011_MODEL_USAGE },
  { version: 12, name: 'subagent_usage', sql: M012_SUBAGENT_USAGE },
  // 13 skipped on purpose — see the comment above M014_EXCLUDED_SPANS.
  { version: 14, name: 'excluded_spans', sql: M014_EXCLUDED_SPANS },
];

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import type { Db } from '../core/db.js';

export interface TitleBackfillResult {
  sessionsChecked: number;
  sessionsResolved: number;
  eventsUpdated: number;
  promptsEnriched: number;
  /** Local days whose topics changed and therefore need re-aggregating. */
  affectedDays: string[];
}

/** Prompt label length. Enough to tell two topics apart, not a transcript. */
const PROMPT_LABEL_CHARS = 200;

/** Transcripts live under `~/.claude/projects/<slug>/<session-id>.jsonl`. */
function transcriptRoot(): string {
  return path.join(homedir(), '.claude', 'projects');
}

/**
 * Last-modified time of each session's transcript, as epoch ms.
 *
 * An independent proof of life. A span left open because its closing event
 * never arrived would otherwise grow to the hard ceiling — inventing hours of
 * billable time out of a lost `Stop`. The transcript is appended to constantly
 * while a session works and goes still the moment it does not, so it bounds an
 * open span at the last instant anything actually happened.
 *
 * Only mtime is read, never the contents: this runs on every aggregation.
 */
export function sessionLiveness(): Map<string, number> {
  const liveness = new Map<string, number>();
  const root = transcriptRoot();
  if (!existsSync(root)) return liveness;

  for (const [sessionId, file] of buildTranscriptIndex(root)) {
    try {
      liveness.set(sessionId, statSync(file).mtimeMs);
    } catch {
      /* vanished between listing and stat */
    }
  }

  return liveness;
}

/** Subagent transcripts are filed as `agent-<agent-id>.jsonl`. */
const AGENT_FILE_PREFIX = 'agent-';

/** One dispatched subagent's own transcript file. */
export interface SubagentTranscript {
  /**
   * The session that dispatched the run. Subagent lines carry the *parent's*
   * id in their own `sessionId` field, so this is what their turns are
   * attributed to — a subagent is not a session of its own.
   */
  sessionId: string;
  agentId: string;
  file: string;
}

/**
 * Every subagent transcript on disk.
 *
 * Filed one level deeper than session transcripts —
 * `<slug>/<session-id>/subagents/agent-<agent-id>.jsonl` — so this is its own
 * walk rather than a filter over `buildTranscriptIndex`, which only looks
 * directly inside `<slug>/`. Two callers now depend on that depth: liveness
 * below, and `captureModelUsage`, whose spend would otherwise stop at the
 * parent file and silently omit everything a subagent burned.
 */
export function subagentTranscripts(): SubagentTranscript[] {
  const found: SubagentTranscript[] = [];
  const root = transcriptRoot();
  if (!existsSync(root)) return found;

  let projects: string[];
  try {
    projects = readdirSync(root, { withFileTypes: true, encoding: 'utf8' })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return found;
  }

  for (const project of projects) {
    const projectDir = path.join(root, project);
    let sessions: string[];
    try {
      sessions = readdirSync(projectDir, { withFileTypes: true, encoding: 'utf8' })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      continue;
    }

    for (const session of sessions) {
      const subagentsDir = path.join(projectDir, session, 'subagents');
      let files;
      try {
        files = readdirSync(subagentsDir, { withFileTypes: true, encoding: 'utf8' });
      } catch {
        continue; // no subagents/ dir — this session never dispatched one
      }

      for (const entry of files) {
        if (!entry.isFile() || !entry.name.endsWith('.jsonl') || !entry.name.startsWith(AGENT_FILE_PREFIX)) continue;
        found.push({
          sessionId: session,
          agentId: entry.name.slice(AGENT_FILE_PREFIX.length, -'.jsonl'.length),
          file: path.join(subagentsDir, entry.name),
        });
      }
    }
  }

  return found;
}

/**
 * Last-modified time of each subagent's *own* transcript, keyed by `agent_id`.
 *
 * A dispatched subagent writes to this file, not the parent session's — the
 * parent goes quiet precisely because it is waiting on the subagent, which is
 * why `sessionLiveness` cannot bound an open subagent span. This file is the
 * subagent's own proof of life: it stops the moment the run actually ends,
 * lost `SubagentStop` or not.
 */
export function subagentLiveness(): Map<string, number> {
  const liveness = new Map<string, number>();

  for (const { agentId, file } of subagentTranscripts()) {
    try {
      const mtime = statSync(file).mtimeMs;
      // Same agent_id can recur across separate runs (see computeSubagentSpans'
      // pairing comment) — keep the most recent sighting.
      const existing = liveness.get(agentId);
      if (existing === undefined || mtime > existing) liveness.set(agentId, mtime);
    } catch {
      /* vanished between listing and stat */
    }
  }

  return liveness;
}

/**
 * Fills in session titles from Claude Code's transcripts.
 *
 * The `session_title` field on the UserPromptSubmit hook payload is documented
 * but arrives empty in practice, which left every description falling back to a
 * raw slice of the prompt — unusable on a client's timesheet. The transcript
 * carries the real thing as `ai-title` entries.
 *
 * Titles are generated a little after a session starts, so this runs on every
 * sync rather than once at ingestion: a session ingested mid-flight gets its
 * title on a later pass. Only sessions still missing one are examined, so the
 * cost is bounded by how many sessions are currently untitled.
 */
export function backfillTitles(db: Db): TitleBackfillResult {
  const result: TitleBackfillResult = {
    sessionsChecked: 0,
    sessionsResolved: 0,
    eventsUpdated: 0,
    promptsEnriched: 0,
    affectedDays: [],
  };

  const root = transcriptRoot();
  if (!existsSync(root)) return result;

  const pending = db
    .prepare(
      `SELECT DISTINCT session_id FROM events
       WHERE (session_title IS NULL OR prompt_excerpt IS NULL)
         AND agent_id IS NULL`,
    )
    .all() as Array<{ session_id: string }>;

  if (pending.length === 0) return result;

  const index = buildTranscriptIndex(root);
  const affected = new Set<string>();

  const daysFor = db.prepare(
    `SELECT DISTINCT strftime('%Y-%m-%d', ts_utc, (tz_offset_min || ' minutes')) AS day
     FROM events WHERE session_id = ?`,
  );
  const update = db.prepare('UPDATE events SET session_title = ? WHERE session_id = ? AND session_title IS NULL');
  const updatePrompt = db.prepare(
    'UPDATE events SET prompt_excerpt = ? WHERE session_id = ? AND prompt_id = ? AND prompt_excerpt IS NULL',
  );

  db.transaction(() => {
    for (const { session_id } of pending) {
      result.sessionsChecked++;

      const file = index.get(session_id);
      if (!file) continue;

      const { title, prompts } = readTranscript(file);
      let touched = false;

      if (title !== null) {
        // Subagents share the session id, so their events pick the title up too
        // and autonomous work is attributed to the same topic.
        const info = update.run(title, session_id);
        result.sessionsResolved++;
        result.eventsUpdated += info.changes;
        touched ||= info.changes > 0;
      }

      // Joined on prompt_id, which both the hook payload and the transcript
      // carry — an exact match rather than a nearest-timestamp guess.
      for (const [promptId, text] of prompts) {
        const info = updatePrompt.run(text, session_id, promptId);
        result.promptsEnriched += info.changes;
        touched ||= info.changes > 0;
      }

      if (touched) {
        for (const row of daysFor.all(session_id) as Array<{ day: string | null }>) {
          if (row.day) affected.add(row.day);
        }
      }
    }
  })();

  result.affectedDays = [...affected].sort();
  return result;
}

/**
 * Maps session id to transcript path in one directory sweep.
 *
 * Transcripts are filed under a slug derived from the project path, which is
 * lossy and awkward to reconstruct; the filename is the session id, so a sweep
 * is both simpler and more reliable than deriving the slug.
 */
export function transcriptIndex(): Map<string, string> {
  const root = transcriptRoot();
  return existsSync(root) ? buildTranscriptIndex(root) : new Map();
}

function buildTranscriptIndex(root: string): Map<string, string> {
  const index = new Map<string, string>();

  let projects: string[];
  try {
    projects = readdirSync(root, { withFileTypes: true, encoding: 'utf8' })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return index;
  }

  for (const project of projects) {
    const dir = path.join(root, project);
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true, encoding: 'utf8' })) {
        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
        const sessionId = entry.name.slice(0, -'.jsonl'.length);
        // Keep the first hit: a session id is unique, and re-filing under a
        // second project would be an artefact rather than a second session.
        if (!index.has(sessionId)) index.set(sessionId, path.join(dir, entry.name));
      }
    } catch {
      /* unreadable project directory */
    }
  }

  return index;
}

interface TranscriptData {
  /**
   * The session's `ai-title`, re-emitted every turn and in practice never
   * revised — so one value per session is the honest granularity here, and
   * topic drift inside a long session must come from tasks instead.
   */
  title: string | null;
  /** Prompt id to a truncated label, for the finest-grained fallback. */
  prompts: Map<string, string>;
}

/** Reads a transcript once, extracting both the title and the prompt labels. */
function readTranscript(file: string): TranscriptData {
  const data: TranscriptData = { title: null, prompts: new Map() };

  let content: string;
  try {
    content = readFileSync(file, 'utf8');
  } catch {
    return data;
  }

  for (const line of content.split('\n')) {
    // Cheap pre-filter: parsing every line of a multi-megabyte transcript would
    // dominate sync time, and most lines are assistant output we never use.
    const isTitle = line.includes('"ai-title"');
    const isUser = !isTitle && line.includes('"type":"user"') && line.includes('"promptId"');
    if (!isTitle && !isUser) continue;

    try {
      const parsed = JSON.parse(line) as {
        type?: unknown;
        aiTitle?: unknown;
        promptId?: unknown;
        message?: { content?: unknown };
      };

      if (parsed.type === 'ai-title') {
        if (typeof parsed.aiTitle === 'string' && parsed.aiTitle.trim().length > 0) {
          data.title = parsed.aiTitle.trim();
        }
        continue;
      }

      if (parsed.type !== 'user' || typeof parsed.promptId !== 'string') continue;
      // Only the first message for a prompt id: a prompt can appear again as a
      // tool result, which is not what you typed.
      if (data.prompts.has(parsed.promptId)) continue;

      const text = extractText(parsed.message?.content);
      if (text) data.prompts.set(parsed.promptId, text);
    } catch {
      /* skip malformed line */
    }
  }

  return data;
}

/** Pulls plain text out of a message body, which may be a string or blocks. */
function extractText(content: unknown): string | null {
  let raw: string | null = null;

  if (typeof content === 'string') {
    raw = content;
  } else if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (typeof block === 'object' && block !== null) {
        const b = block as { type?: unknown; text?: unknown };
        if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
      }
    }
    raw = parts.join(' ');
  }

  if (raw === null) return null;

  const flat = raw.replace(/\s+/g, ' ').trim();
  if (flat.length === 0) return null;
  return flat.length <= PROMPT_LABEL_CHARS ? flat : `${flat.slice(0, PROMPT_LABEL_CHARS - 1)}…`;
}

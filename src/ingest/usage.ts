import { existsSync, readFileSync, statSync } from 'node:fs';

import type { TraickerConfig } from '../core/config.js';
import type { Db } from '../core/db.js';
import { localDay, localOffsetMinutes } from '../core/time.js';
import { resolveProjectId } from './index.js';
import { subagentTranscripts, transcriptIndex } from './titles.js';

export interface UsageCaptureResult {
  /** Transcript files read, not sessions — one session can own several. */
  sessionsScanned: number;
  turnsInserted: number;
  duplicatesSkipped: number;
  /** Local days that gained a new turn, so the rollup knows what to rebuild. */
  affectedDays: string[];
}

interface UsageCursorRow {
  byte_offset: number;
}

interface ParsedTurn {
  messageId: string;
  cwd: string;
  tsUtc: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

/** A transcript file to scan, with the cursor key that resumes it. */
interface ScanTarget {
  /** Unique per file — see M012 for why this is not just the session id. */
  key: string;
  /** Session the turns are attributed to; a subagent's is its parent's. */
  sessionId: string;
  file: string;
}

/**
 * Captures model + token usage from Claude Code's session transcripts.
 *
 * The hook payload never carries either — Claude Code does not put them there
 * — so the transcript is the only source. Unlike the spool reader, transcript
 * lines can be several megabytes (a turn with a large tool result), so this
 * reads the whole file rather than a fixed-size chunk: a chunked read risks
 * never finding a newline inside one chunk. The cursor still makes repeat
 * calls cheap — only the bytes appended since the last pass are parsed.
 *
 * Covers both the session's own transcript and the transcripts of every
 * subagent it dispatched. Subagent turns live in their own files one directory
 * deeper and never appear in the parent's, so reading only the parent
 * undercounted spend by everything the orchestrated agents burned — which for
 * a tool built to measure agent orchestration is precisely the interesting
 * part. Their message ids are disjoint from the parent's, so the existing
 * `INSERT OR IGNORE` on `message_id` needs no help to avoid double-counting.
 *
 * Scoped to sessions trAIcker already has events for, so an ignored or
 * unconfigured project's transcripts are never opened.
 */
export function captureModelUsage(db: Db, config: TraickerConfig): UsageCaptureResult {
  const result: UsageCaptureResult = {
    sessionsScanned: 0,
    turnsInserted: 0,
    duplicatesSkipped: 0,
    affectedDays: [],
  };

  const sessions = db.prepare('SELECT DISTINCT session_id FROM events').all() as Array<{ session_id: string }>;
  if (sessions.length === 0) return result;

  const known = new Set(sessions.map((row) => row.session_id));
  const index = transcriptIndex();
  const affected = new Set<string>();
  const projectCache = new Map<string, number>();
  const declaredRoots = Object.keys(config.projects);

  const targets: ScanTarget[] = [];
  for (const sessionId of known) {
    const file = index.get(sessionId);
    if (file) targets.push({ key: sessionId, sessionId, file });
  }
  for (const { sessionId, agentId, file } of subagentTranscripts()) {
    // Same scoping rule as above: a subagent of a session trAIcker has no
    // events for belongs to an ignored or unconfigured project.
    if (known.has(sessionId)) targets.push({ key: `${sessionId}:agent-${agentId}`, sessionId, file });
  }

  const readCursor = db.prepare('SELECT byte_offset FROM usage_cursor WHERE transcript_key = ?');
  const writeCursor = db.prepare(
    `INSERT INTO usage_cursor (transcript_key, byte_offset, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(transcript_key) DO UPDATE SET byte_offset = excluded.byte_offset, updated_at = excluded.updated_at`,
  );
  const insertTurn = db.prepare(
    `INSERT OR IGNORE INTO model_usage (
       message_id, project_id, session_id, local_day, ts_utc, model,
       input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const offset = localOffsetMinutes();

  for (const { key, sessionId, file } of targets) {
    if (!existsSync(file)) continue;

    let size: number;
    try {
      size = statSync(file).size;
    } catch {
      continue;
    }

    const cursor = readCursor.get(key) as UsageCursorRow | undefined;
    // A file that shrank was rotated or replaced; restart it. The UNIQUE
    // constraint on message_id absorbs whatever gets re-read.
    const startOffset = cursor && cursor.byte_offset <= size ? cursor.byte_offset : 0;
    if (size === startOffset) continue;

    result.sessionsScanned++;

    let content: string;
    try {
      content = readFileSync(file, 'utf8');
    } catch {
      continue;
    }

    const remainder = startOffset > 0 ? sliceRemainder(content, startOffset) : content;

    const lastNewline = remainder.lastIndexOf('\n');
    if (lastNewline === -1) continue; // no complete line since the cursor

    const complete = remainder.slice(0, lastNewline);
    const consumedBytes = startOffset + Buffer.byteLength(complete, 'utf8') + 1;

    let inserted = 0;
    let dupes = 0;

    const runBatch = db.transaction(() => {
      for (const line of complete.split('\n')) {
        // Cheap pre-filter before JSON.parse — most lines are not assistant
        // turns, and parsing every one would dominate sync time on a long
        // transcript.
        if (!line.includes('"type":"assistant"')) continue;

        const turn = parseTurn(line);
        if (!turn) continue;

        const projectId = resolveProjectId(db, config, turn.cwd, projectCache, declaredRoots);
        if (projectId === null) continue;

        const day = localDay(Date.parse(turn.tsUtc), offset);
        const info = insertTurn.run(
          turn.messageId,
          projectId,
          sessionId,
          day,
          turn.tsUtc,
          turn.model,
          turn.inputTokens,
          turn.outputTokens,
          turn.cacheCreationInputTokens,
          turn.cacheReadInputTokens,
        );

        if (info.changes > 0) {
          inserted++;
          affected.add(day);
        } else {
          dupes++;
        }
      }

      writeCursor.run(key, consumedBytes, new Date().toISOString());
    });

    runBatch();

    result.turnsInserted += inserted;
    result.duplicatesSkipped += dupes;
  }

  result.affectedDays = [...affected].sort();
  return result;
}

/** The portion of a fully-read file after a byte offset, decoded as UTF-8. */
function sliceRemainder(content: string, byteOffset: number): string {
  return Buffer.from(content, 'utf8').subarray(byteOffset).toString('utf8');
}

/** Pulls model + usage out of one `type: "assistant"` transcript line. */
function parseTurn(line: string): ParsedTurn | null {
  try {
    const parsed = JSON.parse(line) as {
      type?: unknown;
      cwd?: unknown;
      timestamp?: unknown;
      message?: {
        id?: unknown;
        model?: unknown;
        usage?: {
          input_tokens?: unknown;
          output_tokens?: unknown;
          cache_creation_input_tokens?: unknown;
          cache_read_input_tokens?: unknown;
        };
      };
    };

    if (parsed.type !== 'assistant') return null;
    if (typeof parsed.cwd !== 'string' || typeof parsed.timestamp !== 'string') return null;

    const message = parsed.message;
    if (typeof message?.id !== 'string' || typeof message.model !== 'string') return null;
    // Claude Code's own placeholder for a turn that never reached the model —
    // an auth failure, a server error, an aborted turn. Always zero tokens, so
    // it costs nothing and is not a model; keeping it out avoids a fake
    // all-zero row in the cost table.
    if (message.model === '<synthetic>') return null;

    const usage = message.usage;
    if (
      typeof usage?.input_tokens !== 'number' ||
      typeof usage.output_tokens !== 'number' ||
      typeof usage.cache_creation_input_tokens !== 'number' ||
      typeof usage.cache_read_input_tokens !== 'number'
    ) {
      return null;
    }

    return {
      messageId: message.id,
      cwd: parsed.cwd,
      tsUtc: parsed.timestamp,
      model: message.model,
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      cacheCreationInputTokens: usage.cache_creation_input_tokens,
      cacheReadInputTokens: usage.cache_read_input_tokens,
    };
  } catch {
    return null;
  }
}

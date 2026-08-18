import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import type { TraickerConfig } from '../core/config.js';
import { listProjects, type Db } from '../core/db.js';
import { localDay, localOffsetMinutes, toIso } from '../core/time.js';
import { resolveProjectId } from './index.js';
import { transcriptIndex } from './titles.js';

export interface RecoveredSession {
  sessionId: string;
  projectName: string;
  prompts: number;
  firstUtc: string;
  lastUtc: string;
}

export interface RecoverResult {
  transcriptsScanned: number;
  promptsRecovered: number;
  stopsRecovered: number;
  affectedDays: string[];
  sessions: RecoveredSession[];
}

export interface RecoverOptions {
  /** Inclusive local-day bounds. Omitted means every day on disk. */
  from?: string;
  to?: string;
  /** Report what would be written without writing it. */
  dryRun?: boolean;
}

interface TranscriptEntry {
  at: number;
  isHumanPrompt: boolean;
  promptId: string | null;
  cwd: string | null;
}

/**
 * Rebuilds events for windows where capture was broken.
 *
 * The hook is the only thing that watches a session live, so when it fails the
 * work still happened but nothing recorded it. The transcript did record it —
 * every prompt with its id and timestamp, and every assistant turn — which is
 * enough to reconstruct when work started and when it stopped.
 *
 * Everything written here is marked `source = 'transcript'`, because a billing
 * record has to be able to distinguish what was observed from what was inferred.
 * Idempotent: event ids are content hashes, so re-running changes nothing.
 */
export function recover(db: Db, config: TraickerConfig, options: RecoverOptions = {}): RecoverResult {
  const result: RecoverResult = {
    transcriptsScanned: 0,
    promptsRecovered: 0,
    stopsRecovered: 0,
    affectedDays: [],
    sessions: [],
  };

  const index = transcriptIndex();
  if (index.size === 0) return result;

  const declaredRoots = Object.keys(config.projects);
  const projectCache = new Map<string, number>();
  const projectNames = new Map<number, string>();
  for (const project of listProjects(db)) projectNames.set(project.id, project.name);

  const affected = new Set<string>();

  const capturedPrompts = new Set(
    db
      .prepare(`SELECT prompt_id FROM events WHERE event_type = 'UserPromptSubmit' AND prompt_id IS NOT NULL`)
      .all()
      .map((r) => (r as { prompt_id: string }).prompt_id),
  );

  const sessionProject = db.prepare(
    `SELECT project_id, tz_offset_min FROM events WHERE session_id = ? ORDER BY ts_utc ASC LIMIT 1`,
  );
  const insert = db.prepare(
    `INSERT OR IGNORE INTO events (
       event_uid, event_type, ts_utc, tz_offset_min, project_id, session_id,
       agent_id, agent_type, prompt_id, reason, session_title, prompt_chars,
       prompt_excerpt, task_id, task_subject, duration_ms, source, payload_json, ingested_at
     ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, NULL, NULL, ?, NULL, NULL, NULL, 'transcript', ?, ?)`,
  );

  const run = db.transaction(() => {
    for (const [sessionId, file] of index) {
      if (sessionId.startsWith('agent-')) continue; // subagent transcripts hold no human prompts

      const entries = readTranscript(file);
      if (entries.length === 0) continue;
      result.transcriptsScanned++;

      const humanPrompts = entries.filter((e) => e.isHumanPrompt && e.promptId !== null);
      const missing = humanPrompts.filter(
        (e) => !capturedPrompts.has(e.promptId!) && inRange(e.at, options, offsetFor(db, sessionId, sessionProject)),
      );
      if (missing.length === 0) continue;

      // A session's project is already known if any of its events survived;
      // otherwise fall back to the directory the transcript recorded.
      const known = sessionProject.get(sessionId) as { project_id: number; tz_offset_min: number } | undefined;
      const offset = known?.tz_offset_min ?? localOffsetMinutes();

      let projectId = known?.project_id ?? null;
      if (projectId === null) {
        const cwd = entries.find((e) => e.cwd !== null)?.cwd;
        if (!cwd) continue;
        projectId = resolveProjectId(db, config, cwd, projectCache, declaredRoots);
        if (projectId === null) continue;
      }

      let prompts = 0;
      for (const prompt of missing) {
        const uid = syntheticUid('UserPromptSubmit', sessionId, prompt.promptId!);
        const payload = JSON.stringify({ v: 1, e: 'UserPromptSubmit', t: toIso(prompt.at), reconstructed: true });
        const info = insert.run(
          uid,
          'UserPromptSubmit',
          toIso(prompt.at),
          offset,
          projectId,
          sessionId,
          prompt.promptId,
          'reconstructed',
          null,
          payload,
          new Date().toISOString(),
        );
        if (info.changes === 0) continue;

        prompts++;
        affected.add(localDay(prompt.at, offset));

        // The turn ran until the transcript went quiet, or until the next
        // prompt took over. Without this the span would stay open and be
        // bounded by a liveness check that knows nothing about that window.
        const turnEnd = lastActivityBefore(entries, prompt.at, nextPromptAfter(humanPrompts, prompt.at));
        if (turnEnd !== null && turnEnd > prompt.at) {
          const stopInfo = insert.run(
            syntheticUid('Stop', sessionId, `${prompt.promptId!}-end`),
            'Stop',
            toIso(turnEnd),
            offset,
            projectId,
            sessionId,
            null,
            'reconstructed',
            null,
            JSON.stringify({ v: 1, e: 'Stop', t: toIso(turnEnd), reconstructed: true }),
            new Date().toISOString(),
          );
          if (stopInfo.changes > 0) {
            result.stopsRecovered++;
            affected.add(localDay(turnEnd, offset));
          }
        }
      }

      if (prompts > 0) {
        result.promptsRecovered += prompts;
        result.sessions.push({
          sessionId,
          projectName: projectNames.get(projectId) ?? String(projectId),
          prompts,
          firstUtc: toIso(missing[0]!.at),
          lastUtc: toIso(missing[missing.length - 1]!.at),
        });
      }
    }

    if (options.dryRun) throw new DryRun();
  });

  try {
    run();
  } catch (error) {
    if (!(error instanceof DryRun)) throw error;
  }

  result.affectedDays = [...affected].sort();
  return result;
}

/** Thrown to roll back a dry run once the counts have been gathered. */
class DryRun extends Error {}

function offsetFor(db: Db, sessionId: string, stmt: ReturnType<Db['prepare']>): number {
  const row = stmt.get(sessionId) as { tz_offset_min: number } | undefined;
  return row?.tz_offset_min ?? localOffsetMinutes();
}

function inRange(at: number, options: RecoverOptions, offset: number): boolean {
  const day = localDay(at, offset);
  if (options.from && day < options.from) return false;
  if (options.to && day > options.to) return false;
  return true;
}

function nextPromptAfter(prompts: readonly TranscriptEntry[], at: number): number | null {
  for (const p of prompts) {
    if (p.at > at) return p.at;
  }
  return null;
}

/** Last transcript activity between a prompt and whatever ended its turn. */
function lastActivityBefore(entries: readonly TranscriptEntry[], from: number, until: number | null): number | null {
  let last: number | null = null;
  for (const e of entries) {
    if (e.at <= from) continue;
    if (until !== null && e.at >= until) break;
    last = e.at;
  }
  return last;
}

/**
 * Content-addressed id for a reconstructed event.
 *
 * Distinct from the hook's scheme so a reconstruction can never collide with a
 * real capture, and stable so re-running is a no-op.
 */
function syntheticUid(eventType: string, sessionId: string, key: string): string {
  return createHash('sha1').update(['transcript', eventType, sessionId, key].join('|')).digest('hex');
}

function readTranscript(file: string): TranscriptEntry[] {
  let content: string;
  try {
    content = readFileSync(file, 'utf8');
  } catch {
    return [];
  }

  const entries: TranscriptEntry[] = [];
  const seenPrompts = new Set<string>();

  for (const line of content.split('\n')) {
    if (!line.includes('"timestamp"')) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    const at = Date.parse(String(parsed['timestamp']));
    if (!Number.isFinite(at)) continue;

    const promptId = typeof parsed['promptId'] === 'string' ? parsed['promptId'] : null;
    const origin = parsed['origin'] as { kind?: unknown } | undefined;
    // Only what a person typed counts as a prompt; tool results are also
    // recorded as `user` entries and would invent turns that never happened.
    const isHumanPrompt =
      parsed['type'] === 'user' && origin?.kind === 'human' && promptId !== null && !seenPrompts.has(promptId);
    if (isHumanPrompt) seenPrompts.add(promptId);

    entries.push({
      at,
      isHumanPrompt,
      promptId: isHumanPrompt ? promptId : null,
      cwd: typeof parsed['cwd'] === 'string' ? parsed['cwd'] : null,
    });
  }

  entries.sort((a, b) => a.at - b.at);
  return entries;
}

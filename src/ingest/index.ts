import { createHash } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  statSync,
  type Dirent,
} from 'node:fs';
import path from 'node:path';

import type { TraickerConfig } from '../core/config.js';
import type { Db } from '../core/db.js';
import { listProjects, upsertProject } from '../core/db.js';
import { pathKey, resolveProjectRoot, workspaceRoots } from '../core/paths.js';
import { isTrackedEvent, type SpoolRecord } from '../core/types.js';

export interface IngestResult {
  filesScanned: number;
  linesRead: number;
  eventsInserted: number;
  duplicatesSkipped: number;
  badLines: number;
  /** Local days touched — exactly the days aggregation needs to rebuild. */
  affectedDays: string[];
}

/** Read chunk size when draining a spool file from its cursor. */
const READ_CHUNK = 1 << 20;

/**
 * Folds every unread spool line into the `events` table.
 *
 * Two independent guarantees make this safe to run at any time, including while
 * sessions are actively appending:
 *
 * - Only complete lines are consumed. The cursor advances to the last `\n`, so a
 *   half-written line is left for the next run rather than parsed as garbage.
 * - `event_uid` is UNIQUE and inserts use OR IGNORE. Even a lost or reset cursor
 *   only costs redundant work, never duplicate time.
 */
export function ingest(db: Db, config: TraickerConfig): IngestResult {
  const result: IngestResult = {
    filesScanned: 0,
    linesRead: 0,
    eventsInserted: 0,
    duplicatesSkipped: 0,
    badLines: 0,
    affectedDays: [],
  };

  if (!existsSync(config.spoolDir)) return result;

  const affected = new Set<string>();
  const projectCache = new Map<string, number>();
  // Declared roots beat marker detection, so a client directory without a
  // marker of its own is never absorbed by a parent that has one.
  const declaredRoots = Object.keys(config.projects);

  const readCursor = db.prepare('SELECT byte_offset, line_count, bad_lines FROM spool_cursor WHERE file_path = ?');
  const writeCursor = db.prepare(
    `INSERT INTO spool_cursor (file_path, byte_offset, line_count, bad_lines, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(file_path) DO UPDATE SET
       byte_offset = excluded.byte_offset,
       line_count  = excluded.line_count,
       bad_lines   = excluded.bad_lines,
       updated_at  = excluded.updated_at`,
  );
  const insertEvent = db.prepare(
    `INSERT OR IGNORE INTO events (
       event_uid, event_type, ts_utc, tz_offset_min, project_id, session_id,
       agent_id, agent_type, prompt_id, reason, session_title, prompt_chars,
       prompt_excerpt, task_id, task_subject, duration_ms, source, payload_json, ingested_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'hook', ?, ?)`,
  );

  for (const file of listSpoolFiles(config.spoolDir)) {
    result.filesScanned++;

    const cursor = readCursor.get(file) as
      | { byte_offset: number; line_count: number; bad_lines: number }
      | undefined;
    const startOffset = cursor?.byte_offset ?? 0;

    let size: number;
    try {
      size = statSync(file).size;
    } catch {
      continue;
    }

    // A file that shrank was rotated or replaced; restart it. The UNIQUE
    // constraint absorbs whatever gets re-read.
    const offset = size < startOffset ? 0 : startOffset;
    if (size === offset) continue;

    const { text, bytesRead } = readFrom(file, offset, size);
    if (bytesRead === 0) continue;

    const lastNewline = text.lastIndexOf('\n');
    if (lastNewline === -1) continue; // no complete line yet

    const complete = text.slice(0, lastNewline);
    const consumedBytes = Buffer.byteLength(complete, 'utf8') + 1;

    let inserted = 0;
    let dupes = 0;
    let bad = 0;
    let lines = 0;

    const runBatch = db.transaction(() => {
      for (const line of complete.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        lines++;

        const record = parseRecord(trimmed);
        if (record === null) {
          bad++;
          quarantine(config.spoolDir, file, trimmed);
          continue;
        }

        const projectId = resolveProjectId(db, config, record.cwd, projectCache, declaredRoots);
        if (projectId === null) continue; // ignored path

        const info = insertEvent.run(
          eventUid(record),
          record.e,
          record.t,
          record.tz,
          projectId,
          record.sid,
          record.aid,
          record.at,
          record.pid,
          record.r,
          record.ttl,
          record.plen,
          record.ex,
          record.tid,
          record.tsub,
          record.dur,
          JSON.stringify(record),
          new Date().toISOString(),
        );

        if (info.changes > 0) {
          inserted++;
          affected.add(localDayOf(record));
        } else {
          dupes++;
        }
      }

      writeCursor.run(
        file,
        offset + consumedBytes,
        (cursor?.line_count ?? 0) + lines,
        (cursor?.bad_lines ?? 0) + bad,
        new Date().toISOString(),
      );
    });

    runBatch();

    result.linesRead += lines;
    result.eventsInserted += inserted;
    result.duplicatesSkipped += dupes;
    result.badLines += bad;
  }

  result.affectedDays = [...affected].sort();
  return result;
}

/** All `.ndjson` files under the spool, day directories included. */
function listSpoolFiles(spoolDir: string): string[] {
  const files: string[] = [];

  const walk = (dir: string, depth: number): void => {
    if (depth > 3) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true, encoding: 'utf8' });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.isFile() && entry.name.endsWith('.ndjson') && entry.name !== 'quarantine.ndjson') {
        files.push(full);
      }
    }
  };

  walk(spoolDir, 0);
  return files.sort();
}

function readFrom(file: string, offset: number, size: number): { text: string; bytesRead: number } {
  const length = Math.min(size - offset, READ_CHUNK);
  const buffer = Buffer.allocUnsafe(length);

  let fd: number | null = null;
  try {
    fd = openSync(file, 'r');
    const bytesRead = readSync(fd, buffer, 0, length, offset);
    return { text: buffer.subarray(0, bytesRead).toString('utf8'), bytesRead };
  } catch {
    return { text: '', bytesRead: 0 };
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

function parseRecord(line: string): SpoolRecord | null {
  try {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const r = parsed as Partial<SpoolRecord>;
    if (r.v !== 1) return null;
    if (!isTrackedEvent(r.e)) return null;
    if (typeof r.t !== 'string' || !Number.isFinite(Date.parse(r.t))) return null;
    if (typeof r.tz !== 'number' || !Number.isFinite(r.tz)) return null;
    if (typeof r.cwd !== 'string' || r.cwd.length === 0) return null;
    if (typeof r.sid !== 'string' || r.sid.length === 0) return null;
    return {
      v: 1,
      e: r.e,
      t: r.t,
      tz: r.tz,
      cwd: r.cwd,
      sid: r.sid,
      aid: r.aid ?? null,
      at: r.at ?? null,
      pid: r.pid ?? null,
      r: r.r ?? null,
      ttl: r.ttl ?? null,
      plen: typeof r.plen === 'number' ? r.plen : null,
      ex: r.ex ?? null,
      tid: r.tid ?? null,
      tsub: r.tsub ?? null,
      dur: typeof r.dur === 'number' ? r.dur : null,
    };
  } catch {
    return null;
  }
}

/**
 * Stable identity of an event.
 *
 * Deliberately excludes anything random: two identical events at the same
 * millisecond in the same session for the same agent genuinely are one event
 * written twice, and collapsing them is the correct outcome.
 */
function eventUid(record: SpoolRecord): string {
  return createHash('sha1')
    .update([record.e, record.t, record.sid, record.aid ?? '', record.pid ?? '', record.cwd].join('|'))
    .digest('hex');
}

function localDayOf(record: SpoolRecord): string {
  return new Date(Date.parse(record.t) + record.tz * 60_000).toISOString().slice(0, 10);
}

/**
 * Maps a captured cwd to a project row id, or null when the path is ignored.
 *
 * Root resolution happens here rather than in the hook: it touches the
 * filesystem, and keeping it out of band means the rule can change and the
 * whole history can be reprocessed against the new one.
 */
export function resolveProjectId(
  db: Db,
  config: TraickerConfig,
  cwd: string,
  cache: Map<string, number>,
  declaredRoots: readonly string[] = Object.keys(config.projects),
): number | null {
  const cached = cache.get(cwd);
  if (cached !== undefined) return cached === -1 ? null : cached;

  const root = resolveProjectRoot(cwd, declaredRoots);
  const key = pathKey(root);

  // A declared project always wins over an ignore prefix. Ignoring a workspace
  // directory is the natural way to stop bare sessions in it from becoming a
  // project, and that must not silently delete every client living inside it —
  // including the ones not declared yet. So an ignored path that is a declared
  // workspace only ignores itself, while an ordinary ignore prefix (a scratch
  // tree) still covers everything below it.
  const workspaces = workspaceRoots(declaredRoots);
  const isDeclared = declaredRoots.includes(key);
  const isIgnored =
    !isDeclared &&
    config.ignorePaths.some((prefix) => key === prefix || (!workspaces.has(prefix) && key.startsWith(`${prefix}/`)));

  if (isIgnored) {
    cache.set(cwd, -1);
    return null;
  }

  const project = upsertProject(db, root, config.projects);
  cache.set(cwd, project.id);
  return project.id;
}

export interface ReprojectResult {
  eventsScanned: number;
  eventsMoved: number;
  orphansRemoved: number;
  moves: Array<{ from: string; to: string; count: number }>;
}

/**
 * Re-resolves every event's project from the cwd stored in its payload.
 *
 * Project attribution is the one derived value that lives on `events` rather
 * than being rebuilt by aggregation, so changing the resolution rule — adding a
 * project to config, fixing a misattributed root — needs this to reach history.
 *
 * Safe to run repeatedly: it only ever rewrites `project_id`, and the raw event
 * log is untouched. Aggregation must be re-run afterwards.
 */
export function reproject(db: Db, config: TraickerConfig): ReprojectResult {
  const result: ReprojectResult = { eventsScanned: 0, eventsMoved: 0, orphansRemoved: 0, moves: [] };

  const declaredRoots = Object.keys(config.projects);
  const cache = new Map<string, number>();
  const moves = new Map<string, number>();

  const names = new Map<number, string>();
  for (const project of listProjects(db)) names.set(project.id, project.name);

  // Ordered by time so the earliest event of each session establishes where it
  // was launched.
  const rows = db
    .prepare('SELECT id, project_id, session_id, event_type, payload_json FROM events ORDER BY ts_utc ASC, id ASC')
    .all() as Array<{
    id: number;
    project_id: number;
    session_id: string;
    event_type: string;
    payload_json: string;
  }>;

  /**
   * A session's project, fixed at its first event.
   *
   * Every event in a session belongs to the project the session was launched
   * in. A later cwd — including a CwdChanged — only says an agent went to look
   * at something elsewhere, which is not a change of whose work this is.
   */
  const sessionCwd = new Map<string, string>();

  const update = db.prepare('UPDATE events SET project_id = ? WHERE id = ?');

  db.transaction(() => {
    for (const row of rows) {
      result.eventsScanned++;

      let storedCwd: string;
      try {
        const payload = JSON.parse(row.payload_json) as { cwd?: unknown };
        if (typeof payload.cwd !== 'string') continue;
        storedCwd = payload.cwd;
      } catch {
        continue;
      }

      // A CwdChanged's stored cwd is the directory an agent moved to, not the
      // project the session belongs to — never let it define a session.
      if (row.event_type !== 'CwdChanged' && !sessionCwd.has(row.session_id)) {
        sessionCwd.set(row.session_id, storedCwd);
      }

      const cwd = sessionCwd.get(row.session_id) ?? storedCwd;
      const resolved = resolveProjectId(db, config, cwd, cache, declaredRoots);
      if (resolved === null || resolved === row.project_id) continue;

      update.run(resolved, row.id);
      result.eventsMoved++;

      const from = names.get(row.project_id) ?? String(row.project_id);
      const to = names.get(resolved) ?? projectName(db, resolved);
      names.set(resolved, to);
      const key = `${from} ${to}`;
      moves.set(key, (moves.get(key) ?? 0) + 1);
    }

    // A project left with no events was an artefact of the old rule. Its
    // derived rows have to go first — they hold foreign keys — and a project
    // carrying hand-logged entries is never touched, because that is authored
    // data rather than an artefact.
    const orphanIds = db
      .prepare(
        `SELECT id FROM projects
         WHERE id NOT IN (SELECT DISTINCT project_id FROM events)
           AND id NOT IN (SELECT DISTINCT project_id FROM manual_entries)`,
      )
      .all() as Array<{ id: number }>;

    const clearSpans = db.prepare('DELETE FROM spans WHERE project_id = ?');
    const clearSummary = db.prepare('DELETE FROM daily_summary WHERE project_id = ?');
    const clearTopics = db.prepare('DELETE FROM daily_topics WHERE project_id = ?');
    const dropProject = db.prepare('DELETE FROM projects WHERE id = ?');

    for (const { id } of orphanIds) {
      clearSpans.run(id);
      clearSummary.run(id);
      clearTopics.run(id);
      dropProject.run(id);
      result.orphansRemoved++;
    }
  })();

  result.moves = [...moves.entries()].map(([key, count]) => {
    const [from = '', to = ''] = key.split(' ');
    return { from, to, count };
  });

  return result;
}

function projectName(db: Db, id: number): string {
  const row = db.prepare('SELECT name FROM projects WHERE id = ?').get(id) as { name: string } | undefined;
  return row?.name ?? String(id);
}

/** Parks an unparseable line for inspection instead of dropping it silently. */
function quarantine(spoolDir: string, sourceFile: string, line: string): void {
  try {
    mkdirSync(spoolDir, { recursive: true });
    appendFileSync(
      path.join(spoolDir, 'quarantine.ndjson'),
      `${JSON.stringify({ at: new Date().toISOString(), file: sourceFile, line })}\n`,
      'utf8',
    );
  } catch {
    /* ignore */
  }
}

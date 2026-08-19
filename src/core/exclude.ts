import type { Db } from './db.js';
import { toIso } from './time.js';
import type { ExcludedSpanRow } from './types.js';

export interface NewExclusion {
  projectId: number;
  startUtc: number;
  endUtc: number;
  tzOffsetMin: number;
  note: string | null;
}

export interface ExclusionOverlapConflict {
  entry: ExcludedSpanRow;
}

/**
 * Existing exclusions that overlap a proposed window, on the *same* project
 * only.
 *
 * Unlike a manual entry, an exclusion does not claim "you were here" — two
 * unrelated exclusions can legitimately cover the same minute on different
 * projects. Only the same project overlapping itself is a real duplicate.
 */
export function findExclusionOverlaps(
  db: Db,
  projectId: number,
  startUtc: number,
  endUtc: number,
  excludeId?: number,
): ExclusionOverlapConflict[] {
  return db
    .prepare(
      `SELECT * FROM excluded_spans
       WHERE project_id = ? AND start_utc < ? AND end_utc > ?
         AND (? IS NULL OR id != ?)
       ORDER BY start_utc`,
    )
    .all(projectId, toIso(endUtc), toIso(startUtc), excludeId ?? null, excludeId ?? null)
    .map((row) => ({ entry: row as ExcludedSpanRow }));
}

export function insertExclusion(db: Db, entry: NewExclusion): ExcludedSpanRow {
  const now = new Date().toISOString();
  const info = db
    .prepare(
      `INSERT INTO excluded_spans (project_id, start_utc, end_utc, tz_offset_min, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(entry.projectId, toIso(entry.startUtc), toIso(entry.endUtc), entry.tzOffsetMin, entry.note, now);

  return db.prepare('SELECT * FROM excluded_spans WHERE id = ?').get(info.lastInsertRowid) as ExcludedSpanRow;
}

export function deleteExclusion(db: Db, id: number): ExcludedSpanRow | null {
  const entry = db.prepare('SELECT * FROM excluded_spans WHERE id = ?').get(id) as ExcludedSpanRow | undefined;
  if (!entry) return null;
  db.prepare('DELETE FROM excluded_spans WHERE id = ?').run(id);
  return entry;
}

export interface ExcludedSpanWithProject extends ExcludedSpanRow {
  project_name: string;
}

export function listExclusions(db: Db, fromDay: string, toDay: string): ExcludedSpanWithProject[] {
  return db
    .prepare(
      `SELECT e.*, p.name AS project_name
       FROM excluded_spans e
       JOIN projects p ON p.id = e.project_id
       WHERE date(e.start_utc, (e.tz_offset_min || ' minutes')) BETWEEN ? AND ?
       ORDER BY e.start_utc ASC`,
    )
    .all(fromDay, toDay) as ExcludedSpanWithProject[];
}

/** Exclusions overlapping a UTC window, for aggregation. */
export function exclusionsInRange(db: Db, fromUtc: number, toUtc: number): ExcludedSpanRow[] {
  return db
    .prepare('SELECT * FROM excluded_spans WHERE end_utc > ? AND start_utc < ? ORDER BY start_utc ASC')
    .all(toIso(fromUtc), toIso(toUtc)) as ExcludedSpanRow[];
}

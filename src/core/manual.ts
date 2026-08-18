import type { Db } from './db.js';
import { localDay, splitAtLocalMidnight, toIso, toMs } from './time.js';
import type { ManualEntryRow, ManualKind, Span } from './types.js';

export interface NewManualEntry {
  projectId: number;
  startUtc: number;
  endUtc: number;
  tzOffsetMin: number;
  kind: ManualKind;
  note: string | null;
}

export interface OverlapConflict {
  entry: ManualEntryRow;
  projectName: string;
}

/**
 * Existing entries that overlap a proposed window, on any project.
 *
 * Manual time is exclusive by definition — you cannot be in two meetings at
 * once — so an overlap is almost always a typo, and silently accepting it would
 * inflate the day.
 */
export function findOverlaps(db: Db, startUtc: number, endUtc: number, excludeId?: number): OverlapConflict[] {
  return db
    .prepare(
      `SELECT m.*, p.name AS project_name
       FROM manual_entries m
       JOIN projects p ON p.id = m.project_id
       WHERE m.start_utc < ? AND m.end_utc > ?
         AND (? IS NULL OR m.id != ?)
       ORDER BY m.start_utc`,
    )
    .all(toIso(endUtc), toIso(startUtc), excludeId ?? null, excludeId ?? null)
    .map((row) => {
      const r = row as ManualEntryRow & { project_name: string };
      const { project_name, ...entry } = r;
      return { entry, projectName: project_name };
    });
}

export function insertManualEntry(db: Db, entry: NewManualEntry): ManualEntryRow {
  const now = new Date().toISOString();
  const info = db
    .prepare(
      `INSERT INTO manual_entries (project_id, start_utc, end_utc, tz_offset_min, kind, note, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(entry.projectId, toIso(entry.startUtc), toIso(entry.endUtc), entry.tzOffsetMin, entry.kind, entry.note, now, now);

  return db.prepare('SELECT * FROM manual_entries WHERE id = ?').get(info.lastInsertRowid) as ManualEntryRow;
}

export function deleteManualEntry(db: Db, id: number): ManualEntryRow | null {
  const entry = db.prepare('SELECT * FROM manual_entries WHERE id = ?').get(id) as ManualEntryRow | undefined;
  if (!entry) return null;
  db.prepare('DELETE FROM manual_entries WHERE id = ?').run(id);
  return entry;
}

export interface ManualEntryWithProject extends ManualEntryRow {
  project_name: string;
}

export function listManualEntries(db: Db, fromDay: string, toDay: string): ManualEntryWithProject[] {
  return db
    .prepare(
      `SELECT m.*, p.name AS project_name
       FROM manual_entries m
       JOIN projects p ON p.id = m.project_id
       WHERE date(m.start_utc, (m.tz_offset_min || ' minutes')) BETWEEN ? AND ?
       ORDER BY m.start_utc ASC`,
    )
    .all(fromDay, toDay) as ManualEntryWithProject[];
}

/** Entries overlapping a UTC window, for aggregation. */
export function manualEntriesInRange(db: Db, fromUtc: number, toUtc: number): ManualEntryRow[] {
  return db
    .prepare('SELECT * FROM manual_entries WHERE end_utc > ? AND start_utc < ? ORDER BY start_utc ASC')
    .all(toIso(fromUtc), toIso(toUtc)) as ManualEntryRow[];
}

/**
 * Turns entries into focus spans.
 *
 * Hand-logged time is attention by definition — a meeting is you, present, on
 * one thing — so it belongs in the focus bucket and inherits its mutual
 * exclusivity across projects.
 */
export function manualSpans(entries: readonly ManualEntryRow[]): Span[] {
  const spans: Span[] = [];

  for (const entry of entries) {
    const start = toMs(entry.start_utc);
    const end = toMs(entry.end_utc);
    if (end <= start) continue;

    for (const slice of splitAtLocalMidnight(start, end, entry.tz_offset_min)) {
      spans.push({
        bucket: 'focus',
        source: 'manual',
        project_id: entry.project_id,
        session_id: `manual-${entry.id}`,
        agent_id: null,
        agent_type: null,
        title: entry.note ?? defaultLabel(entry.kind),
        // Authored by you, so it is safe to show a client — unlike a slice of
        // prompt text, which is not written to be read.
        title_source: 'manual',
        local_day: slice.localDay,
        start_utc: toIso(slice.start),
        end_utc: toIso(slice.end),
        duration_ms: slice.end - slice.start,
        truncated_by: null,
      });
    }
  }

  return spans;
}

function defaultLabel(kind: ManualKind): string {
  switch (kind) {
    case 'meeting':
      return 'Meeting';
    case 'research':
      return 'Research';
    case 'review':
      return 'Review';
    case 'admin':
      return 'Admin';
    case 'other':
      return 'Off-tool work';
  }
}

/** The local day an entry starts on. */
export function entryDay(entry: ManualEntryRow): string {
  return localDay(toMs(entry.start_utc), entry.tz_offset_min);
}

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

import { MIGRATIONS } from './migrations.js';
import { defaultProjectName, normalizePath, pathKey } from './paths.js';
import type { ProjectOverride, TraickerConfig } from './config.js';
import type { ProjectRow } from './types.js';

export type Db = Database.Database;

/**
 * Opens the database, creating and migrating it as needed.
 *
 * WAL is on so the dashboard can read while a sync writes. Nothing on the hook
 * path ever reaches this function — the hook only appends to the spool — so
 * lock contention here is bounded to trAIcker's own processes.
 */
export function openDb(config: TraickerConfig): Db {
  mkdirSync(path.dirname(config.dbPath), { recursive: true });

  const db = new Database(config.dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  migrate(db);
  return db;
}

function migrate(db: Db): void {
  const current = db.pragma('user_version', { simple: true }) as number;

  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    db.exec('BEGIN');
    try {
      db.exec(migration.sql);
      db.pragma(`user_version = ${migration.version}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw new Error(`migration ${migration.version} (${migration.name}) failed: ${String(error)}`);
    }
  }
}

export function getMeta(db: Db, key: string): string | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setMeta(db: Db, key: string, value: string): void {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    key,
    value,
  );
}

/**
 * Finds or creates the project row for a path, applying config overrides.
 *
 * Identity is `path_key` (case-folded), not `path`, so `C:/Dev/app` and
 * `C:/dev/app` are one project rather than two — a real hazard on Windows where
 * the shell and the editor disagree about drive-letter case.
 */
export function upsertProject(db: Db, projectPath: string, overrides: Record<string, ProjectOverride>): ProjectRow {
  const normalized = normalizePath(projectPath);
  const key = pathKey(normalized);
  const override = overrides[key];

  const existing = db.prepare('SELECT * FROM projects WHERE path_key = ?').get(key) as ProjectRow | undefined;

  if (existing) {
    const name = override?.name ?? existing.name;
    const client = override?.client ?? existing.client;
    const billable = override?.billable === undefined ? existing.billable : override.billable ? 1 : 0;
    const color = override?.color ?? existing.color;

    if (
      name !== existing.name ||
      client !== existing.client ||
      billable !== existing.billable ||
      color !== existing.color
    ) {
      db.prepare('UPDATE projects SET name = ?, client = ?, billable = ?, color = ? WHERE id = ?').run(
        name,
        client,
        billable,
        color,
        existing.id,
      );
      return { ...existing, name, client, billable, color };
    }
    return existing;
  }

  const info = db
    .prepare(
      'INSERT INTO projects (path, path_key, name, client, billable, color, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      normalized,
      key,
      override?.name ?? defaultProjectName(normalized),
      override?.client ?? null,
      // A newly detected project is not billable until you say it is. Most
      // directories you open are your own; billing is the exception, and the
      // failure modes are not symmetric — an unmarked client shows up as a
      // missing project you notice, while an unmarked personal project quietly
      // inflates a total that goes to a client.
      override?.billable === true ? 1 : 0,
      override?.color ?? null,
      new Date().toISOString(),
    );

  return db.prepare('SELECT * FROM projects WHERE id = ?').get(info.lastInsertRowid) as ProjectRow;
}

/**
 * Re-applies config overrides to every existing project row.
 *
 * Project metadata is otherwise only written when an event for that project is
 * ingested, so renaming a client or fixing a label in config would sit
 * invisible until the next time you happened to work on it.
 */
export function refreshProjectMetadata(db: Db, overrides: Record<string, ProjectOverride>): number {
  let updated = 0;

  const update = db.prepare('UPDATE projects SET name = ?, client = ?, billable = ?, color = ? WHERE id = ?');

  db.transaction(() => {
    for (const project of listProjects(db)) {
      const override = overrides[project.path_key];

      // Removing a project from config has to undo what it set, otherwise a
      // name or a billable flag lingers in the database with nothing on disk
      // explaining where it came from.
      if (!override) {
        const fallback = defaultProjectName(project.path);
        if (project.name !== fallback || project.client !== null || project.billable !== 0 || project.color !== null) {
          update.run(fallback, null, 0, null, project.id);
          updated++;
        }
        continue;
      }

      const name = override.name ?? project.name;
      const client = override.client ?? project.client;
      const billable = override.billable === undefined ? project.billable : override.billable ? 1 : 0;
      const color = override.color ?? null;

      if (
        name === project.name &&
        client === project.client &&
        billable === project.billable &&
        color === project.color
      ) {
        continue;
      }

      update.run(name, client, billable, color, project.id);
      updated++;
    }
  })();

  return updated;
}

export function listProjects(db: Db): ProjectRow[] {
  return db.prepare('SELECT * FROM projects ORDER BY name COLLATE NOCASE').all() as ProjectRow[];
}

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ProjectOverride } from '../src/core/config.js';
import { openDb, refreshProjectMetadata, upsertProject, type Db } from '../src/core/db.js';
import { normalizePath, pathKey } from '../src/core/paths.js';

let root: string;
let db: Db;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'traicker-projects-'));
  db = openDb({
    dataDir: root,
    dbPath: path.join(root, 'time.db'),
    spoolDir: path.join(root, 'spool'),
    idleTimeoutMinutes: 15,
    idleAttributionCapMinutes: 120,
    stitchGapMinutes: 10,
    maxTurnMinutes: 120,
    maxSubagentMinutes: 120,
    promptExcerptChars: 80,
    spoolRetentionDays: 7,
    spoolRetentionAction: 'keep',
    ignorePaths: [],
    projects: {},
    modelPricing: {},
    serverPort: 4317,
    translationModel: 'claude-opus-5',
    llmBaseUrl: 'https://openrouter.ai/api/v1',
  });
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

const key = (p: string) => pathKey(normalizePath(p));
const overrides = (p: string, o: ProjectOverride) => ({ [key(p)]: o });

/**
 * Whether a project is billable defaults to no.
 *
 * The two mistakes are not equally expensive. An unmarked client shows up as a
 * project missing from a total you were about to invoice — visible, and caught
 * before it costs anything. An unmarked personal project silently adds hours to
 * a figure a client reads.
 */
describe('billable default', () => {
  it('creates an undeclared project as not billable', () => {
    const project = upsertProject(db, path.join(root, 'some-repo'), {});
    expect(project.billable).toBe(0);
  });

  it('honours an explicit billable: true', () => {
    const dir = path.join(root, 'client');
    const project = upsertProject(db, dir, overrides(dir, { billable: true }));
    expect(project.billable).toBe(1);
  });

  it('honours an explicit billable: false', () => {
    const dir = path.join(root, 'client');
    const project = upsertProject(db, dir, overrides(dir, { billable: false }));
    expect(project.billable).toBe(0);
  });

  it('leaves an override in place across a later event', () => {
    const dir = path.join(root, 'client');
    upsertProject(db, dir, overrides(dir, { billable: true }));
    const again = upsertProject(db, dir, overrides(dir, { billable: true }));
    expect(again.billable).toBe(1);
  });

  it('does not silently un-bill a declared project when config omits the flag', () => {
    // `name` alone must not reset billing — a config entry that renames a
    // client would otherwise drop it out of every billable total.
    const dir = path.join(root, 'client');
    upsertProject(db, dir, overrides(dir, { billable: true }));

    const renamed = upsertProject(db, dir, overrides(dir, { name: 'Client' }));
    expect(renamed.billable).toBe(1);
    expect(renamed.name).toBe('Client');
  });

  it('falls back to not billable when the project is removed from config', () => {
    // Removing an entry has to undo what it set, or a billable flag lingers in
    // the database with nothing on disk explaining where it came from.
    const dir = path.join(root, 'client');
    upsertProject(db, dir, overrides(dir, { name: 'Client', billable: true }));

    refreshProjectMetadata(db, {});

    const row = db.prepare('SELECT billable FROM projects WHERE path_key = ?').get(key(dir)) as {
      billable: number;
    };
    expect(row.billable).toBe(0);
  });

  it('applies a config flip to an existing project without an event', () => {
    const dir = path.join(root, 'client');
    upsertProject(db, dir, {});

    const changed = refreshProjectMetadata(db, overrides(dir, { billable: true }));
    expect(changed).toBe(1);

    const row = db.prepare('SELECT billable FROM projects WHERE path_key = ?').get(key(dir)) as {
      billable: number;
    };
    expect(row.billable).toBe(1);
  });
});

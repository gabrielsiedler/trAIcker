import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { TraickerConfig } from '../src/core/config.js';
import { openDb, upsertProject, type Db } from '../src/core/db.js';
import { commitmentStatuses } from '../src/report/commitments.js';

const HOUR = 3_600_000;

let root: string;
let db: Db;
let config: TraickerConfig;

function makeConfig(dataDir: string): TraickerConfig {
  return {
    dataDir,
    dbPath: path.join(dataDir, 'time.db'),
    spoolDir: path.join(dataDir, 'spool'),
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
  };
}

/** Wednesday of the week starting Monday 2026-08-10, mid-afternoon local. */
const MID_WEEK = Date.parse('2026-08-12T18:00:00.000Z');
/** Sunday evening of the same week. */
const WEEK_END = Date.parse('2026-08-16T22:00:00.000Z');

function addProject(dir: string, hours: number, kind: 'cap' | 'target', weeklyHours: number): number {
  const project = upsertProject(db, path.join(root, dir), {});
  const id = project.id;

  config.projects[project.path_key] = {
    commitment: { weeklyHours, kind, weekStartsOn: 'monday' },
  };

  db.prepare(
    `INSERT INTO daily_summary (local_day, project_id, focus_ms, agent_wall_ms, agent_effort_ms,
                                occupancy_ms, idle_dropped_ms, prompt_count, session_count, subagent_count)
     VALUES ('2026-08-11', ?, 0, 0, 0, ?, 0, 1, 1, 0)`,
  ).run(id, hours * HOUR);

  return id;
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'traicker-commit-'));
  config = makeConfig(root);
  db = openDb(config);
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe('commitmentStatuses', () => {
  it('ignores projects with no arrangement', () => {
    upsertProject(db, path.join(root, 'personal'), {});
    expect(commitmentStatuses(db, config, MID_WEEK)).toHaveLength(0);
  });

  it('breaches a cap from above', () => {
    addProject('hourly', 12, 'cap', 10);

    const [status] = commitmentStatuses(db, config, MID_WEEK);
    expect(status!.kind).toBe('cap');
    expect(status!.hours).toBe(12);
    expect(status!.deltaHours).toBe(2);
    expect(status!.breached).toBe(true);
  });

  it('does not breach a cap while under it', () => {
    addProject('hourly', 7, 'cap', 10);
    expect(commitmentStatuses(db, config, MID_WEEK)[0]!.breached).toBe(false);
  });

  it('does not flag a target mid-week', () => {
    // Four of twenty hours on a Wednesday is not a problem, and flagging it
    // would train you to ignore the indicator.
    addProject('parttime', 4, 'target', 20);

    const [status] = commitmentStatuses(db, config, MID_WEEK);
    expect(status!.breached).toBe(false);
    expect(status!.weekElapsed).toBeLessThan(0.95);
  });

  it('flags a missed target once the week is over', () => {
    addProject('parttime', 12, 'target', 20);

    const [status] = commitmentStatuses(db, config, WEEK_END);
    expect(status!.kind).toBe('target');
    expect(status!.deltaHours).toBe(-8);
    expect(status!.breached).toBe(true);
  });

  it('does not flag a target that was met', () => {
    addProject('parttime', 21, 'target', 20);
    expect(commitmentStatuses(db, config, WEEK_END)[0]!.breached).toBe(false);
  });

  it('reads a cap and a target in opposite directions at the same hours', () => {
    // Identical hours against identical numbers, opposite verdicts — the reason
    // the two cannot share one field.
    addProject('under-cap', 8, 'cap', 10);
    addProject('under-target', 8, 'target', 10);

    const statuses = commitmentStatuses(db, config, WEEK_END);
    const cap = statuses.find((s) => s.projectName === 'under-cap')!;
    const target = statuses.find((s) => s.projectName === 'under-target')!;

    expect(cap.breached).toBe(false);
    expect(target.breached).toBe(true);
  });
});

import { mkdtempSync, mkdirSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { aggregate } from '../src/aggregate/run.js';
import type { TraickerConfig } from '../src/core/config.js';
import { openDb, type Db } from '../src/core/db.js';
import { ingest } from '../src/ingest/index.js';
import type { SpoolRecord } from '../src/core/types.js';

const MIN = 60_000;
const TZ = -180;
const DAY = '2026-08-10';

let root: string;
let config: TraickerConfig;
let db: Db;

function makeConfig(dataDir: string): TraickerConfig {
  return {
    dataDir,
    dbPath: path.join(dataDir, 'time.db'),
    spoolDir: path.join(dataDir, 'spool'),
    idleTimeoutMinutes: 15,
    idleAttributionCapMinutes: 120,
    maxTurnMinutes: 120,
    maxSubagentMinutes: 120,
    promptExcerptChars: 80,
    stitchGapMinutes: 10,
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

/** Appends a spool line exactly as the hook would. */
function spool(session: string, record: Partial<SpoolRecord> & Pick<SpoolRecord, 'e' | 't' | 'cwd'>): void {
  const dir = path.join(config.spoolDir, DAY);
  mkdirSync(dir, { recursive: true });
  const full: SpoolRecord = {
    v: 1,
    tz: TZ,
    sid: session,
    aid: null,
    at: null,
    pid: null,
    r: null,
    ttl: null,
    plen: null,
    ex: null,
    ...record,
  } as SpoolRecord;
  appendFileSync(path.join(dir, `${session}.ndjson`), `${JSON.stringify(full)}\n`, 'utf8');
}

const CLIENT_A = path.join(tmpdir(), 'traicker-fixture', 'client-a');
const CLIENT_B = path.join(tmpdir(), 'traicker-fixture', 'client-b');

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'traicker-test-'));
  mkdirSync(path.join(CLIENT_A, '.git'), { recursive: true });
  mkdirSync(path.join(CLIENT_B, '.git'), { recursive: true });
  config = makeConfig(root);
  db = openDb(config);
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe('spool -> sqlite -> aggregate', () => {
  it('ingests, aggregates, and stays stable across repeated runs', () => {
    // Client A gets 10 minutes of attention, then B takes over for 5, then A
    // again. Meanwhile A has two subagents running in parallel.
    spool('sa', { e: 'SessionStart', t: '2026-08-10T12:00:00.000Z', cwd: CLIENT_A });
    spool('sa', { e: 'UserPromptSubmit', t: '2026-08-10T12:00:00.000Z', cwd: CLIENT_A, ttl: 'Refactor auth', plen: 40 });
    spool('sa', { e: 'SubagentStart', t: '2026-08-10T12:01:00.000Z', cwd: CLIENT_A, aid: 'a1', at: 'Explore' });
    spool('sa', { e: 'SubagentStart', t: '2026-08-10T12:01:00.000Z', cwd: CLIENT_A, aid: 'a2', at: 'Explore' });
    spool('sb', { e: 'UserPromptSubmit', t: '2026-08-10T12:10:00.000Z', cwd: CLIENT_B, ttl: 'Stripe webhook', plen: 20 });
    spool('sa', { e: 'SubagentStop', t: '2026-08-10T12:31:00.000Z', cwd: CLIENT_A, aid: 'a1', at: 'Explore' });
    spool('sa', { e: 'SubagentStop', t: '2026-08-10T12:31:00.000Z', cwd: CLIENT_A, aid: 'a2', at: 'Explore' });
    spool('sa', { e: 'Stop', t: '2026-08-10T12:31:00.000Z', cwd: CLIENT_A });
    spool('sb', { e: 'Stop', t: '2026-08-10T12:12:00.000Z', cwd: CLIENT_B });
    spool('sa', { e: 'UserPromptSubmit', t: '2026-08-10T12:15:00.000Z', cwd: CLIENT_A, ttl: 'Refactor auth', plen: 15 });
    spool('sa', { e: 'SessionEnd', t: '2026-08-10T12:40:00.000Z', cwd: CLIENT_A, r: 'clear' });

    const now = Date.parse('2026-08-10T12:20:00.000Z');

    const first = ingest(db, config);
    expect(first.eventsInserted).toBe(11);
    expect(first.badLines).toBe(0);
    expect(first.affectedDays).toEqual([DAY]);

    aggregate(db, config, { days: [DAY], now });

    const rows = db
      .prepare(
        `SELECT p.name, s.focus_ms, s.agent_wall_ms, s.agent_effort_ms, s.occupancy_ms,
                s.prompt_count, s.subagent_count
         FROM daily_summary s JOIN projects p ON p.id = s.project_id
         WHERE s.local_day = ? ORDER BY p.name`,
      )
      .all(DAY) as Array<Record<string, number | string>>;

    const a = rows.find((r) => r['name'] === 'client-a')!;
    const b = rows.find((r) => r['name'] === 'client-b')!;

    // Focus: A owns 12:00-12:10 (ended by B's prompt), B owns 12:10-12:15
    // (ended by A's prompt), A owns 12:15-12:20 (up to now).
    expect(a['focus_ms']).toBe(15 * MIN);
    expect(b['focus_ms']).toBe(5 * MIN);
    expect(a['prompt_count']).toBe(2);
    expect(a['subagent_count']).toBe(2);

    // Both projects had agents running simultaneously - overlap is allowed.
    expect(a['agent_wall_ms']).toBeGreaterThan(0);
    expect(b['agent_wall_ms']).toBeGreaterThan(0);
    // Two parallel subagents mean effort exceeds wall-clock.
    expect(a['agent_effort_ms']).toBeGreaterThan(a['agent_wall_ms'] as number);

    // Billable time covers the agent runs that focus alone would have missed,
    // while never exceeding the wall-clock those runs actually occupied.
    expect(a['occupancy_ms']).toBeGreaterThan(a['focus_ms'] as number);
    expect(a['occupancy_ms']).toBeLessThanOrEqual(a['agent_effort_ms'] as number);

    // Re-ingesting and re-aggregating must not change a single number.
    const second = ingest(db, config);
    expect(second.eventsInserted).toBe(0);
    aggregate(db, config, { days: [DAY], now });
    aggregate(db, config, { days: [DAY], now });

    const after = db
      .prepare(
        `SELECT p.name, s.focus_ms, s.agent_wall_ms, s.agent_effort_ms, s.occupancy_ms,
                s.prompt_count, s.subagent_count
         FROM daily_summary s JOIN projects p ON p.id = s.project_id
         WHERE s.local_day = ? ORDER BY p.name`,
      )
      .all(DAY);

    expect(after).toEqual(rows);
    expect(db.prepare('SELECT COUNT(*) AS n FROM events').get()).toEqual({ n: 11 });
  });

  it('is idempotent even when the spool cursor is lost', () => {
    spool('sa', { e: 'UserPromptSubmit', t: '2026-08-10T12:00:00.000Z', cwd: CLIENT_A, plen: 5 });
    spool('sa', { e: 'Stop', t: '2026-08-10T12:05:00.000Z', cwd: CLIENT_A });

    ingest(db, config);
    db.prepare('DELETE FROM spool_cursor').run();
    const replay = ingest(db, config);

    // Every line is read again, and the UNIQUE constraint absorbs all of it.
    expect(replay.linesRead).toBe(2);
    expect(replay.eventsInserted).toBe(0);
    expect(replay.duplicatesSkipped).toBe(2);
    expect(db.prepare('SELECT COUNT(*) AS n FROM events').get()).toEqual({ n: 2 });
  });

  it('leaves a half-written trailing line for the next run', () => {
    const dir = path.join(config.spoolDir, DAY);
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'sa.ndjson');

    spool('sa', { e: 'UserPromptSubmit', t: '2026-08-10T12:00:00.000Z', cwd: CLIENT_A, plen: 5 });
    // A line still being appended by a live session: no trailing newline yet.
    appendFileSync(file, '{"v":1,"e":"Stop","t":"2026-08-10T12:05:00.0', 'utf8');

    const partial = ingest(db, config);
    expect(partial.eventsInserted).toBe(1);
    expect(partial.badLines).toBe(0);

    // The session finishes writing it.
    appendFileSync(file, `00Z","tz":${TZ},"cwd":"${CLIENT_A.replace(/\\/g, '/')}","sid":"sa"}\n`, 'utf8');

    const complete = ingest(db, config);
    expect(complete.eventsInserted).toBe(1);
    expect(complete.badLines).toBe(0);
  });

  it('quarantines corrupt lines without losing the rest of the file', () => {
    const dir = path.join(config.spoolDir, DAY);
    mkdirSync(dir, { recursive: true });
    spool('sa', { e: 'UserPromptSubmit', t: '2026-08-10T12:00:00.000Z', cwd: CLIENT_A, plen: 5 });
    appendFileSync(path.join(dir, 'sa.ndjson'), 'not json at all\n', 'utf8');
    spool('sa', { e: 'Stop', t: '2026-08-10T12:05:00.000Z', cwd: CLIENT_A });

    const result = ingest(db, config);
    expect(result.badLines).toBe(1);
    expect(result.eventsInserted).toBe(2);
  });

  it('treats drive-letter case differences as one project', () => {
    const upper = CLIENT_A.replace(/^([a-z]):/, (_m, d: string) => `${d.toUpperCase()}:`);
    const lower = CLIENT_A.replace(/^([A-Z]):/, (_m, d: string) => `${d.toLowerCase()}:`);

    spool('sa', { e: 'UserPromptSubmit', t: '2026-08-10T12:00:00.000Z', cwd: upper, plen: 5 });
    spool('sb', { e: 'UserPromptSubmit', t: '2026-08-10T12:05:00.000Z', cwd: lower, plen: 5 });

    ingest(db, config);
    expect(db.prepare('SELECT COUNT(*) AS n FROM projects').get()).toEqual({ n: 1 });
  });
});

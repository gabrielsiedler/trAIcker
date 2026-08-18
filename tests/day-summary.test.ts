import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { BillingConfig, TraickerConfig } from '../src/core/config.js';
import { openDb, upsertProject, type Db } from '../src/core/db.js';
import { buildTimesheet, collectDayActivity } from '../src/report/timesheet.js';
import { clearDaySummary, readDaySummary, saveDaySummary, summarizeDay } from '../src/translate/summarize.js';

const HOUR = 3_600_000;
const DAY = '2026-08-10';
const RANGE = { from: '2026-08-01', to: '2026-08-31' };

const BILLING: BillingConfig = {
  basis: 'occupancy',
  roundToMinutes: 15,
  weekStartsOn: 'monday',
  allowExcerpts: false,
};

let root: string;
let db: Db;
let projectId: number;
let cfg: TraickerConfig;

function config(dataDir: string): TraickerConfig {
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

function addDay(occupancyMs: number): void {
  db.prepare(
    `INSERT INTO daily_summary (local_day, project_id, focus_ms, agent_wall_ms, agent_effort_ms,
                                occupancy_ms, idle_dropped_ms, prompt_count, session_count, subagent_count)
     VALUES (?, ?, 0, 0, 0, ?, 0, 1, 1, 0)`,
  ).run(DAY, projectId, occupancyMs);
}

function addTopic(title: string, occupancyMs: number): void {
  db.prepare(
    `INSERT INTO daily_topics (local_day, project_id, title, title_source, focus_ms, agent_wall_ms,
                               occupancy_ms, prompt_count, first_utc, last_utc)
     VALUES (?, ?, ?, 'session_title', 0, 0, ?, 1, ?, ?)`,
  ).run(DAY, projectId, title, occupancyMs, `${DAY}T12:00:00.000Z`, `${DAY}T13:00:00.000Z`);
}

/** `tsUtc` is the real instant; `offsetMin` is the local offset at capture. */
function addPrompt(uid: string, excerpt: string | null, tsUtc: string, offsetMin = -180): void {
  db.prepare(
    `INSERT INTO events (event_uid, event_type, ts_utc, tz_offset_min, project_id, session_id,
                         prompt_excerpt, payload_json, ingested_at, source)
     VALUES (?, 'UserPromptSubmit', ?, ?, ?, 's1', ?, '{}', ?, 'hook')`,
  ).run(uid, tsUtc, offsetMin, projectId, excerpt, new Date().toISOString());
}

function saveSummary(text: string): void {
  saveDaySummary(
    db,
    projectId,
    DAY,
    { summary: text, inputKind: 'excerpts', inputCount: 3, error: null },
    'claude-opus-5',
    'English',
  );
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'traicker-summary-'));
  cfg = config(root);
  db = openDb(cfg);
  projectId = upsertProject(db, path.join(root, 'acme'), {}).id;
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe('collectDayActivity', () => {
  it('returns titles ranked by share of the day', () => {
    addTopic('Small tweak', 15 * 60_000);
    addTopic('Main feature work', 3 * HOUR);

    expect(collectDayActivity(db, projectId, DAY).titles).toEqual(['Main feature work', 'Small tweak']);
  });

  it('returns prompts in the order they were typed', () => {
    // The sequence is part of the evidence — what was tried, what it became.
    // A description written from a shuffled day reads as unrelated fragments.
    addPrompt('c', 'third thing', `${DAY}T18:00:00.000Z`);
    addPrompt('a', 'first thing', `${DAY}T13:00:00.000Z`);
    addPrompt('b', 'second thing', `${DAY}T15:00:00.000Z`);

    expect(collectDayActivity(db, projectId, DAY).excerpts).toEqual([
      'first thing',
      'second thing',
      'third thing',
    ]);
  });

  it('groups prompts by local day, not by UTC day', () => {
    // 21:30 local on the 10th is 00:30 UTC on the 11th at UTC-3. Grouping by
    // the UTC date would move an evening's work onto the next day's invoice.
    addPrompt('late', 'evening work', `${DAY}T23:30:00.000Z`.replace(DAY, '2026-08-11'), -180);
    addPrompt('noon', 'afternoon work', `${DAY}T17:00:00.000Z`, -180);

    const activity = collectDayActivity(db, projectId, DAY);
    expect(activity.excerpts).toEqual(['afternoon work']);
  });

  it('skips prompts with no excerpt stored', () => {
    // promptExcerptChars can be 0, and a recovered event may carry none.
    addPrompt('a', null, `${DAY}T13:00:00.000Z`);
    addPrompt('b', '   ', `${DAY}T14:00:00.000Z`);
    addPrompt('c', 'real one', `${DAY}T15:00:00.000Z`);

    expect(collectDayActivity(db, projectId, DAY).excerpts).toEqual(['real one']);
  });
});

describe('description precedence', () => {
  it('prefers a stored summary over the joined titles', () => {
    addDay(3 * HOUR);
    addTopic('Define project priorities and infrastructure setup plan', 3 * HOUR);
    saveSummary('Defined scope and set up the repository.');

    const entry = buildTimesheet(db, 'acme', RANGE, BILLING)!.weeks[0]!.entries[0]!;
    expect(entry.description).toBe('Defined scope and set up the repository.');
    expect(entry.descriptionSource).toBe('day-summary');
    // The joined line stays available so the two can be compared.
    expect(entry.generatedDescription).toContain('Define project priorities');
  });

  it('keeps your own note above a stored summary', () => {
    // You get the last word on a line a client reads. A refresh must never
    // silently replace wording you chose.
    addDay(3 * HOUR);
    addTopic('Whatever the session was called', 3 * HOUR);
    saveSummary('A model wrote this.');
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO timesheet_notes (local_day, project_id, note, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(DAY, projectId, 'I wrote this.', now, now);

    const entry = buildTimesheet(db, 'acme', RANGE, BILLING)!.weeks[0]!.entries[0]!;
    expect(entry.description).toBe('I wrote this.');
    expect(entry.descriptionSource).toBe('manual-note');
  });

  it('falls back to the joined titles once the summary is cleared', () => {
    addDay(3 * HOUR);
    addTopic('Session title', 3 * HOUR);
    saveSummary('Rewritten line.');

    expect(clearDaySummary(db, projectId, DAY)).toBe(true);
    expect(readDaySummary(db, projectId, DAY)).toBeNull();

    const entry = buildTimesheet(db, 'acme', RANGE, BILLING)!.weeks[0]!.entries[0]!;
    expect(entry.description).toBe('Session title');
    expect(entry.descriptionSource).toBe('generated');
  });

  it('does not leak a summary onto a different day', () => {
    addDay(3 * HOUR);
    addTopic('Session title', 3 * HOUR);
    saveSummary('Only for the 10th.');

    db.prepare(
      `INSERT INTO daily_summary (local_day, project_id, focus_ms, agent_wall_ms, agent_effort_ms,
                                  occupancy_ms, idle_dropped_ms, prompt_count, session_count, subagent_count)
       VALUES ('2026-08-11', ?, 0, 0, 0, ?, 0, 1, 1, 0)`,
    ).run(projectId, HOUR);

    const entries = buildTimesheet(db, 'acme', RANGE, BILLING)!.weeks.flatMap((w) => w.entries);
    const other = entries.find((e) => e.day === '2026-08-11')!;
    expect(other.description).not.toBe('Only for the 10th.');
  });
});

describe('summarizeDay', () => {
  it('reports an empty day without calling out', async () => {
    const result = await summarizeDay(cfg, { titles: [], excerpts: [] }, 'English');
    expect(result.summary).toBeNull();
    expect(result.error).toBe('no activity recorded for that day');
  });

  it('never throws, and never writes, when the API is unreachable', async () => {
    // The whole point of returning an error rather than raising: a failed
    // refresh must leave the existing line exactly as it was.
    addDay(3 * HOUR);
    addTopic('Session title', 3 * HOUR);

    const result = await summarizeDay(
      { ...cfg, translationModel: 'claude-opus-5' },
      { titles: ['Session title'], excerpts: ['did a thing'] },
      'English',
    );

    if (result.summary === null) {
      expect(result.error).toBeTruthy();
      expect(readDaySummary(db, projectId, DAY)).toBeNull();
      expect(buildTimesheet(db, 'acme', RANGE, BILLING)!.weeks[0]!.entries[0]!.description).toBe('Session title');
    } else {
      // Credentials are present in this environment: then it must respect the
      // one hard promise the line makes — a single line, within the cap.
      expect(result.summary).not.toContain('\n');
      expect(result.summary.length).toBeLessThanOrEqual(220);
    }
  });

  it('records excerpts as the input kind when prompts are available', async () => {
    const result = await summarizeDay(cfg, { titles: ['t'], excerpts: ['a', 'b'] }, 'English');
    expect(result.inputKind).toBe('excerpts');
    expect(result.inputCount).toBe(2);
  });

  it('falls back to titles when the day has no prompt text', async () => {
    const result = await summarizeDay(cfg, { titles: ['t1', 't2'], excerpts: [] }, 'English');
    expect(result.inputKind).toBe('titles');
    expect(result.inputCount).toBe(2);
  });
});

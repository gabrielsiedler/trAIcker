import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { BillingConfig, TraickerConfig } from '../src/core/config.js';
import { openDb, upsertProject, type Db } from '../src/core/db.js';
import { buildTimesheet, currentBillingWeek, timesheetCsv } from '../src/report/timesheet.js';

const HOUR = 3_600_000;
const MIN = 60_000;

let root: string;
let db: Db;
let projectId: number;

const BILLING: BillingConfig = {
  basis: 'occupancy',
  weeklyCapHours: 10,
  roundToMinutes: 15,
  weekStartsOn: 'monday',
  allowExcerpts: false,
};

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

function addDay(day: string, occupancyMs: number, focusMs = 0): void {
  db.prepare(
    `INSERT INTO daily_summary (local_day, project_id, focus_ms, agent_wall_ms, agent_effort_ms,
                                occupancy_ms, idle_dropped_ms, prompt_count, session_count, subagent_count)
     VALUES (?, ?, ?, 0, 0, ?, 0, 1, 1, 0)`,
  ).run(day, projectId, focusMs, occupancyMs);
}

function addTopic(
  day: string,
  title: string,
  occupancyMs: number,
  focusMs = 0,
  source: 'session_title' | 'prompt_excerpt' = 'session_title',
): void {
  db.prepare(
    `INSERT INTO daily_topics (local_day, project_id, title, title_source, focus_ms, agent_wall_ms,
                               occupancy_ms, prompt_count, first_utc, last_utc)
     VALUES (?, ?, ?, ?, ?, 0, ?, 1, ?, ?)`,
  ).run(day, projectId, title, source, focusMs, occupancyMs, `${day}T12:00:00.000Z`, `${day}T13:00:00.000Z`);
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'traicker-ts-'));
  const cfg = config(root);
  db = openDb(cfg);
  projectId = upsertProject(db, path.join(root, 'acme'), {}).id;
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

const RANGE = { from: '2026-08-01', to: '2026-08-31' };

describe('buildTimesheet', () => {
  it('produces one entry per day with hours and a description', () => {
    addDay('2026-08-10', 2 * HOUR + 20 * MIN);
    addTopic('2026-08-10', 'Build payments API', 2 * HOUR);
    addTopic('2026-08-10', 'Fix webhook retry', 20 * MIN);

    const sheet = buildTimesheet(db, 'acme', RANGE, BILLING)!;
    const entry = sheet.weeks[0]!.entries[0]!;

    expect(entry.day).toBe('2026-08-10');
    expect(entry.hours).toBe(2.25); // 2h20 rounded to the nearest 15 min
    expect(entry.description).toBe('Build payments API; Fix webhook retry');
  });

  it('orders the description by how much of the day each topic took', () => {
    addDay('2026-08-10', 3 * HOUR);
    addTopic('2026-08-10', 'Small tweak', 15 * MIN);
    addTopic('2026-08-10', 'Main feature work', 2 * HOUR + 45 * MIN);

    const sheet = buildTimesheet(db, 'acme', RANGE, BILLING)!;
    expect(sheet.weeks[0]!.entries[0]!.description).toBe('Main feature work; Small tweak');
  });

  it('keeps a topic that has focus time but never dominated a block', () => {
    addDay('2026-08-10', 1 * HOUR);
    addTopic('2026-08-10', 'Long agent run', 1 * HOUR);
    // This topic lost every block to the one above, so its occupancy is zero —
    // but the work happened and must not vanish from the description.
    addTopic('2026-08-10', 'Reviewed the migration plan', 0, 12 * MIN);

    const sheet = buildTimesheet(db, 'acme', RANGE, BILLING)!;
    expect(sheet.weeks[0]!.entries[0]!.description).toContain('Reviewed the migration plan');
  });

  it('groups by week and flags going over the cap', () => {
    // Mon-Fri of one week, 2.5h each = 12.5h against a 10h cap.
    for (const day of ['2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13', '2026-08-14']) {
      addDay(day, 2 * HOUR + 30 * MIN);
      addTopic(day, 'Feature work', 2 * HOUR + 30 * MIN);
    }

    const sheet = buildTimesheet(db, 'acme', RANGE, BILLING)!;
    expect(sheet.weeks).toHaveLength(1);
    expect(sheet.weeks[0]!.weekStart).toBe('2026-08-10'); // a Monday
    expect(sheet.weeks[0]!.hours).toBe(12.5);
    expect(sheet.weeks[0]!.overCap).toBe(true);
  });

  it('reports the cap without trimming the hours actually worked', () => {
    addDay('2026-08-10', 20 * HOUR);
    addTopic('2026-08-10', 'Marathon', 20 * HOUR);

    const sheet = buildTimesheet(db, 'acme', RANGE, BILLING)!;
    // Cutting hours to fit a contract is the user's call, not the tracker's.
    expect(sheet.weeks[0]!.hours).toBe(20);
    expect(sheet.weeks[0]!.overCap).toBe(true);
  });

  it('splits days across week boundaries', () => {
    addDay('2026-08-09', 1 * HOUR); // Sunday
    addDay('2026-08-10', 1 * HOUR); // Monday
    addTopic('2026-08-09', 'Weekend fix', 1 * HOUR);
    addTopic('2026-08-10', 'Monday work', 1 * HOUR);

    const sheet = buildTimesheet(db, 'acme', RANGE, BILLING)!;
    expect(sheet.weeks.map((w) => w.weekStart)).toEqual(['2026-08-03', '2026-08-10']);
  });

  it('makes the weekly total the sum of the rounded days', () => {
    // Each day rounds up by 3 minutes; the week must match the typed lines.
    addDay('2026-08-10', 1 * HOUR + 7 * MIN);
    addDay('2026-08-11', 1 * HOUR + 7 * MIN);
    addTopic('2026-08-10', 'Work', 1 * HOUR);
    addTopic('2026-08-11', 'Work', 1 * HOUR);

    const sheet = buildTimesheet(db, 'acme', RANGE, BILLING)!;
    expect(sheet.weeks[0]!.entries.map((e) => e.hours)).toEqual([1, 1]);
    expect(sheet.weeks[0]!.hours).toBe(2);
  });

  it('bills focus instead when the basis says so', () => {
    addDay('2026-08-10', 3 * HOUR, 30 * MIN);
    addTopic('2026-08-10', 'Work', 3 * HOUR, 30 * MIN);

    const sheet = buildTimesheet(db, 'acme', RANGE, { ...BILLING, basis: 'focus' })!;
    expect(sheet.weeks[0]!.entries[0]!.hours).toBe(0.5);
  });

  it('keeps raw prompt text off a client timesheet', () => {
    addDay('2026-08-10', 2 * HOUR);
    addTopic('2026-08-10', 'Build the checkout flow', 1 * HOUR);
    addTopic(
      '2026-08-10',
      '1. Sim, sou admin 2. vamos discutir mais sobre o deploy',
      1 * HOUR,
      0,
      'prompt_excerpt',
    );

    const sheet = buildTimesheet(db, 'acme', RANGE, BILLING)!;
    const description = sheet.weeks[0]!.entries[0]!.description;

    expect(description).toBe('Build the checkout flow');
    expect(description).not.toContain('Sim, sou admin');
  });

  it('includes excerpts when the client explicitly allows them', () => {
    addDay('2026-08-10', 1 * HOUR);
    addTopic('2026-08-10', 'reviewed the deploy script', 1 * HOUR, 0, 'prompt_excerpt');

    const allowed = buildTimesheet(db, 'acme', RANGE, { ...BILLING, allowExcerpts: true })!;
    expect(allowed.weeks[0]!.entries[0]!.description).toBe('reviewed the deploy script');
  });

  it('falls back to a neutral description rather than leaking prompt text', () => {
    addDay('2026-08-10', 1 * HOUR);
    addTopic('2026-08-10', 'algum texto cru que eu digitei', 1 * HOUR, 0, 'prompt_excerpt');

    // The hours are still billed; only the description degrades.
    const sheet = buildTimesheet(db, 'acme', RANGE, BILLING)!;
    expect(sheet.weeks[0]!.entries[0]!.hours).toBe(1);
    expect(sheet.weeks[0]!.entries[0]!.description).toBe('Development and review.');
  });

  it('falls back to a neutral description when no topic is available', () => {
    addDay('2026-08-10', 1 * HOUR);

    const sheet = buildTimesheet(db, 'acme', RANGE, BILLING)!;
    expect(sheet.weeks[0]!.entries[0]!.description).toBe('Development and review.');
  });

  it('returns null when there is nothing billable', () => {
    expect(buildTimesheet(db, 'acme', RANGE, BILLING)).toBeNull();
  });

  it('defaults to the calendar week, not a rolling seven days', () => {
    // Thursday. A rolling window would reach back into the previous week and
    // report a total that matches neither week's cap.
    const range = currentBillingWeek(BILLING, Date.parse('2026-08-13T15:00:00.000Z'));

    expect(range.from).toBe('2026-08-10'); // Monday
    expect(range.to).toBe('2026-08-16'); // Sunday
  });

  it('honours a Sunday week start', () => {
    const range = currentBillingWeek(
      { ...BILLING, weekStartsOn: 'sunday' },
      Date.parse('2026-08-13T15:00:00.000Z'),
    );

    expect(range.from).toBe('2026-08-09');
    expect(range.to).toBe('2026-08-15');
  });

  it('lets your own note win over the generated description', () => {
    addDay('2026-08-10', 1 * HOUR);
    addTopic('2026-08-10', 'Criar harness autônomo com Storybook', 1 * HOUR);

    db.prepare(
      `INSERT INTO timesheet_notes (local_day, project_id, note, created_at, updated_at)
       VALUES ('2026-08-10', ?, ?, '2026-08-10T00:00:00Z', '2026-08-10T00:00:00Z')`,
    ).run(projectId, 'Built an autonomous Storybook test harness');

    const entry = buildTimesheet(db, 'acme', RANGE, BILLING)!.weeks[0]!.entries[0]!;
    expect(entry.description).toBe('Built an autonomous Storybook test harness');
    expect(entry.descriptionSource).toBe('manual-note');
    // The generated text is kept so the UI can show what it replaced.
    expect(entry.generatedDescription).toBe('Criar harness autônomo com Storybook');
  });

  it('uses a cached translation when the client bills in another language', () => {
    addDay('2026-08-10', 1 * HOUR);
    addTopic('2026-08-10', 'Criar harness autônomo com Storybook', 1 * HOUR);

    db.prepare(
      `INSERT INTO translations (source_hash, target_lang, source_text, translated, model, created_at)
       VALUES (?, 'English', ?, ?, 'test', '2026-08-10T00:00:00Z')`,
    ).run(
      createHash('sha1').update('Criar harness autônomo com Storybook').digest('hex'),
      'Criar harness autônomo com Storybook',
      'Build an autonomous Storybook harness',
    );

    const entry = buildTimesheet(db, 'acme', RANGE, { ...BILLING, translateTo: 'English' })!.weeks[0]!
      .entries[0]!;
    expect(entry.description).toBe('Build an autonomous Storybook harness');
    expect(entry.descriptionSource).toBe('translated');
  });

  it('keeps the original wording when no translation is cached', () => {
    // A missing translation must degrade to the source text, never to blank —
    // the hours still have to be billable.
    addDay('2026-08-10', 1 * HOUR);
    addTopic('2026-08-10', 'Criar harness autônomo', 1 * HOUR);

    const entry = buildTimesheet(db, 'acme', RANGE, { ...BILLING, translateTo: 'English' })!.weeks[0]!
      .entries[0]!;
    expect(entry.description).toBe('Criar harness autônomo');
    expect(entry.hours).toBe(1);
  });

  it('escapes quotes in CSV output', () => {
    addDay('2026-08-10', 1 * HOUR);
    addTopic('2026-08-10', 'Fix the "retry" bug', 1 * HOUR);

    const csv = timesheetCsv(buildTimesheet(db, 'acme', RANGE, BILLING)!);
    expect(csv).toContain('"Fix the ""retry"" bug"');
  });
});

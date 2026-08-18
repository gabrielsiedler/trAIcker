import { billingFor, commitmentFor, type BillingConfig, type TraickerConfig } from '../core/config.js';
import { listProjects, type Db } from '../core/db.js';
import { localDay, localOffsetMinutes, roundToIncrement, toHours, weekStart } from '../core/time.js';
import { UNTITLED } from '../aggregate/summary.js';
import type { ProjectRow } from '../core/types.js';
import { readCache } from '../translate/index.js';
import type { DateRange } from './queries.js';

/** Applied when a project has no billing block — occupancy, no cap. */
export const DEFAULT_BILLING: BillingConfig = {
  basis: 'occupancy',
  roundToMinutes: 15,
  weekStartsOn: 'monday',
  allowExcerpts: false,
};

export interface ResolvedBilling {
  project: ProjectRow;
  billing: BillingConfig;
  /** False when defaults were substituted for a missing billing block. */
  configured: boolean;
}

/**
 * The ceiling a timesheet reports against.
 *
 * Only a `cap` applies here. A `target` is a commitment to meet, not a limit to
 * stay under — showing a timesheet as "3 of 20h" would read as a breach when
 * it is simply Tuesday.
 */
function capHoursFor(config: TraickerConfig, projectPath: string, billing: BillingConfig): number | undefined {
  const commitment = commitmentFor(config, projectPath);
  if (commitment) return commitment.kind === 'cap' ? commitment.weeklyHours : undefined;
  return billing.weeklyCapHours;
}

/**
 * Matches a project by name or path fragment and resolves its billing rules.
 *
 * Config is keyed by absolute path while commands and the dashboard take a
 * friendly fragment, so the lookup has to go through the project row.
 */
export function resolveBilling(db: Db, config: TraickerConfig, filter: string): ResolvedBilling | null {
  const needle = filter.toLowerCase();
  const project = listProjects(db).find(
    (p) => p.name.toLowerCase().includes(needle) || p.path.toLowerCase().includes(needle),
  );
  if (!project) return null;

  const billing = billingFor(config, project.path) ?? DEFAULT_BILLING;
  const capHours = capHoursFor(config, project.path, billing);

  return {
    project,
    billing: { ...billing, weeklyCapHours: capHours },
    configured: billingFor(config, project.path) !== null,
  };
}

export type DescriptionSource = 'manual-note' | 'day-summary' | 'translated' | 'generated' | 'fallback';

export interface TimesheetEntry {
  day: string;
  /** Needed to refresh or annotate this one line without re-resolving it. */
  projectId: number;
  /** Actual measured time, before rounding. */
  rawMs: number;
  /** What goes in the form. */
  hours: number;
  description: string;
  /** Where the description came from — you wrote it, or it was derived. */
  descriptionSource: DescriptionSource;
  /** The generated text, kept even when a note overrides it. */
  generatedDescription: string;
  /** Topics behind the description, largest first. */
  topics: string[];
}

/**
 * Everything a day's description could be written from.
 *
 * Titles are what the joined description already uses. Excerpts are the only
 * per-task signal that survives: Claude Code names a session once, from its
 * opening minutes, so a day of eight tasks inside one session carries one
 * title. They are truncated prompt text and never reach a client directly.
 */
export interface DayActivityRows {
  titles: string[];
  excerpts: string[];
}

export function collectDayActivity(db: Db, projectId: number, day: string): DayActivityRows {
  const titles = (
    db
      .prepare(
        `SELECT title FROM daily_topics
         WHERE project_id = ? AND local_day = ? AND title <> ?
         ORDER BY (occupancy_ms + focus_ms + agent_wall_ms) DESC`,
      )
      .all(projectId, day, UNTITLED) as Array<{ title: string }>
  ).map((r) => r.title);

  // Ordered as typed: the sequence is part of the evidence — what was tried,
  // what it turned into — and a description written from a shuffled day reads
  // like a list of unrelated fragments.
  const excerpts = (
    db
      .prepare(
        `SELECT prompt_excerpt FROM events
         WHERE project_id = ? AND event_type = 'UserPromptSubmit'
           AND prompt_excerpt IS NOT NULL AND trim(prompt_excerpt) <> ''
           AND date(ts_utc, (tz_offset_min || ' minutes')) = ?
         ORDER BY ts_utc ASC`,
      )
      .all(projectId, day) as Array<{ prompt_excerpt: string }>
  ).map((r) => r.prompt_excerpt);

  return { titles, excerpts };
}

export interface TimesheetWeek {
  weekStart: string;
  entries: TimesheetEntry[];
  hours: number;
  capHours: number | null;
  overCap: boolean;
}

export interface Timesheet {
  projectName: string;
  client: string | null;
  basis: BillingConfig['basis'];
  range: DateRange;
  weeks: TimesheetWeek[];
  totalHours: number;
}

/**
 * Sets your own wording for one day's line. Wins over a generated or
 * rewritten description until removed — see `note ?? summary ?? generated`
 * in `buildTimesheet`.
 */
export function saveDayNote(db: Db, projectId: number, day: string, text: string): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO timesheet_notes (local_day, project_id, note, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(local_day, project_id) DO UPDATE SET note = excluded.note, updated_at = excluded.updated_at`,
  ).run(day, projectId, text, now, now);
}

/** Drops a manual note, returning the day to whatever it would otherwise show. */
export function clearDayNote(db: Db, projectId: number, day: string): boolean {
  const info = db.prepare('DELETE FROM timesheet_notes WHERE local_day = ? AND project_id = ?').run(day, projectId);
  return info.changes > 0;
}

/** Description length ceiling — a timesheet note, not a changelog. */
const MAX_DESCRIPTION = 220;

interface DayRow {
  local_day: string;
  project_id: number;
  project_name: string;
  client: string | null;
  occupancy_ms: number;
  focus_ms: number;
}

interface TopicRow {
  local_day: string;
  title: string;
  title_source: string;
  occupancy_ms: number;
  focus_ms: number;
  agent_wall_ms: number;
}

/**
 * Builds the per-day entries an hourly client's form expects.
 *
 * Descriptions come from Claude Code's own session titles, snapshotted at each
 * prompt. Nothing here measures code — commit counts and diff size became the
 * most forgeable signal available the moment agents started writing the code,
 * so time is both the more honest and the harder-to-fake record.
 */
export function buildTimesheet(
  db: Db,
  projectFilter: string,
  range: DateRange,
  billing: BillingConfig,
): Timesheet | null {
  const days = db
    .prepare(
      `SELECT s.local_day, s.project_id, p.name AS project_name, p.client, s.occupancy_ms, s.focus_ms
       FROM daily_summary s
       JOIN projects p ON p.id = s.project_id
       WHERE s.local_day BETWEEN ? AND ?
         AND (p.name LIKE ? COLLATE NOCASE OR p.path LIKE ? COLLATE NOCASE)
       ORDER BY s.local_day ASC`,
    )
    .all(range.from, range.to, `%${projectFilter}%`, `%${projectFilter}%`) as DayRow[];

  if (days.length === 0) return null;

  const topics = db
    .prepare(
      `SELECT t.local_day, t.title, t.title_source, t.occupancy_ms, t.focus_ms, t.agent_wall_ms
       FROM daily_topics t
       JOIN projects p ON p.id = t.project_id
       WHERE t.local_day BETWEEN ? AND ?
         AND (p.name LIKE ? COLLATE NOCASE OR p.path LIKE ? COLLATE NOCASE)`,
    )
    .all(range.from, range.to, `%${projectFilter}%`, `%${projectFilter}%`) as TopicRow[];

  const topicsByDay = new Map<string, TopicRow[]>();
  for (const topic of topics) {
    const list = topicsByDay.get(topic.local_day);
    if (list) list.push(topic);
    else topicsByDay.set(topic.local_day, [topic]);
  }

  // Your own wording, keyed by day. Applied last so it beats everything.
  const notes = new Map<string, string>();
  for (const row of db
    .prepare(
      `SELECT n.local_day, n.note
       FROM timesheet_notes n
       JOIN projects p ON p.id = n.project_id
       WHERE n.local_day BETWEEN ? AND ?
         AND (p.name LIKE ? COLLATE NOCASE OR p.path LIKE ? COLLATE NOCASE)`,
    )
    .all(range.from, range.to, `%${projectFilter}%`, `%${projectFilter}%`) as Array<{
    local_day: string;
    note: string;
  }>) {
    notes.set(row.local_day, row.note);
  }

  // A description a model wrote after reading the whole day. Written only when
  // you ask for it, and kept afterwards — a billing line must not change its
  // wording between the day you read it and the day you submit it.
  const summaries = new Map<string, string>();
  for (const row of db
    .prepare(
      `SELECT d.local_day, d.summary
       FROM day_summaries d
       JOIN projects p ON p.id = d.project_id
       WHERE d.local_day BETWEEN ? AND ?
         AND (p.name LIKE ? COLLATE NOCASE OR p.path LIKE ? COLLATE NOCASE)`,
    )
    .all(range.from, range.to, `%${projectFilter}%`, `%${projectFilter}%`) as Array<{
    local_day: string;
    summary: string;
  }>) {
    summaries.set(row.local_day, row.summary);
  }

  // Cached translations only — this function never calls out to the network.
  // A description is rendered from what is already known; filling the cache is
  // a separate, explicit step.
  const translations = billing.translateTo
    ? readCache(db, topics.map((t) => t.title), billing.translateTo)
    : new Map<string, string>();

  const entries: TimesheetEntry[] = [];

  for (const day of days) {
    const rawMs = billing.basis === 'focus' ? day.focus_ms : day.occupancy_ms;
    const roundedMs = roundToIncrement(rawMs, billing.roundToMinutes);
    if (roundedMs <= 0) continue;

    const dayTopics = rankTopics(topicsByDay.get(day.local_day) ?? [], billing.allowExcerpts);
    const rendered = dayTopics.map((topic) => translations.get(topic) ?? topic);
    const generated = describe(rendered);

    const note = notes.get(day.local_day);
    const summary = summaries.get(day.local_day);
    const anyTranslated = dayTopics.some((topic) => translations.has(topic));

    // Your own wording first, then a summary you explicitly asked for, then
    // what can be derived without asking anyone. Each step is more deliberate
    // than the one below it, and the more deliberate wording wins.
    const description = note ?? summary ?? generated;
    const descriptionSource: DescriptionSource = note
      ? 'manual-note'
      : summary
        ? 'day-summary'
        : dayTopics.length === 0
          ? 'fallback'
          : anyTranslated
            ? 'translated'
            : 'generated';

    entries.push({
      day: day.local_day,
      projectId: day.project_id,
      rawMs,
      hours: toHours(roundedMs),
      description,
      descriptionSource,
      generatedDescription: generated,
      topics: dayTopics,
    });
  }

  if (entries.length === 0) return null;

  const byWeek = new Map<string, TimesheetEntry[]>();
  for (const entry of entries) {
    const key = weekStart(entry.day, billing.weekStartsOn);
    const list = byWeek.get(key);
    if (list) list.push(entry);
    else byWeek.set(key, [entry]);
  }

  const cap = billing.weeklyCapHours ?? null;
  const weeks: TimesheetWeek[] = [...byWeek.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([start, weekEntries]) => {
      // Sum of rounded days, not the rounded sum: the client adds up the lines
      // they were given, so the total has to match those lines exactly.
      const hours = Math.round(weekEntries.reduce((sum, e) => sum + e.hours, 0) * 100) / 100;
      return {
        weekStart: start,
        entries: weekEntries,
        hours,
        capHours: cap,
        overCap: cap !== null && hours > cap,
      };
    });

  const first = days[0]!;
  return {
    projectName: first.project_name,
    client: first.client,
    basis: billing.basis,
    range,
    weeks,
    totalHours: Math.round(weeks.reduce((sum, w) => sum + w.hours, 0) * 100) / 100,
  };
}

/**
 * Orders a day's topics by significance.
 *
 * Ranking uses occupancy, focus and agent time together rather than occupancy
 * alone: a block carries one dominant title, so a genuine topic can hold zero
 * occupancy while having real focus behind it, and dropping it would lose work
 * from the description.
 */
function rankTopics(rows: readonly TopicRow[], allowExcerpts: boolean): string[] {
  return rows
    .filter((r) => r.title !== UNTITLED && r.title.trim().length > 0)
    // Meeting notes, task subjects and generated titles are written to be read;
    // raw prompt text is not, and this string goes onto an invoice a client sees.
    .filter(
      (r) =>
        allowExcerpts ||
        r.title_source === 'manual' ||
        r.title_source === 'task' ||
        r.title_source === 'session_title',
    )
    .map((r) => ({ title: r.title, weight: r.occupancy_ms + r.focus_ms + r.agent_wall_ms }))
    .filter((r) => r.weight > 0)
    .sort((a, b) => b.weight - a.weight)
    .map((r) => r.title);
}

/**
 * Joins topics into one continuous line, which is what a form field wants —
 * no bullets, no newlines to mangle on paste.
 */
function describe(topics: readonly string[]): string {
  if (topics.length === 0) return 'Development and review.';

  const parts: string[] = [];
  let length = 0;

  for (const topic of topics) {
    const clean = topic.replace(/\s+/g, ' ').trim();
    if (clean.length === 0) continue;
    // +2 for the "; " separator.
    if (length + clean.length + 2 > MAX_DESCRIPTION) break;
    parts.push(clean);
    length += clean.length + 2;
  }

  if (parts.length === 0) return truncate(topics[0]!.replace(/\s+/g, ' ').trim(), MAX_DESCRIPTION);

  const joined = parts.join('; ');
  const remaining = topics.length - parts.length;
  return remaining > 0 ? `${joined} (+${remaining} more)` : joined;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/**
 * The calendar week containing `now`, honouring the client's week boundary.
 *
 * A timesheet must not default to a rolling seven days: the cap is contractual
 * and weekly, so a window straddling two weeks would report partial totals for
 * both and match neither.
 */
export function currentBillingWeek(billing: BillingConfig, now = Date.now()): DateRange {
  const today = localDay(now, localOffsetMinutes());
  const from = weekStart(today, billing.weekStartsOn);
  const to = new Date(Date.parse(`${from}T00:00:00.000Z`) + 6 * 86_400_000).toISOString().slice(0, 10);
  return { from, to };
}

/** CSV for spreadsheets, when the form is not the destination. */
export function timesheetCsv(sheet: Timesheet): string {
  const rows = ['date,hours,description'];
  for (const week of sheet.weeks) {
    for (const entry of week.entries) {
      rows.push(`${entry.day},${entry.hours.toFixed(2)},"${entry.description.replace(/"/g, '""')}"`);
    }
  }
  return rows.join('\n');
}

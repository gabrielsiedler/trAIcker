import { formatDuration, toHours } from '../core/time.js';
import type { DateRange, ProjectDayRow, ProjectTotalRow, TopicRow } from './queries.js';
import type { CommitmentStatus } from './commitments.js';
import type { Timesheet } from './timesheet.js';

const COLOR = process.stdout.isTTY && !process.env['NO_COLOR'];

const dim = (s: string) => (COLOR ? `[2m${s}[0m` : s);
const bold = (s: string) => (COLOR ? `[1m${s}[0m` : s);
const cyan = (s: string) => (COLOR ? `[36m${s}[0m` : s);
const yellow = (s: string) => (COLOR ? `[33m${s}[0m` : s);
const green = (s: string) => (COLOR ? `[32m${s}[0m` : s);

/** Visible width, ignoring ANSI escapes so padding survives colouring. */
function width(s: string): number {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\[[0-9;]*m/g, '').length;
}

function pad(s: string, to: number, align: 'left' | 'right' = 'left'): string {
  const gap = Math.max(0, to - width(s));
  return align === 'left' ? s + ' '.repeat(gap) : ' '.repeat(gap) + s;
}

export function table(headers: string[], rows: string[][], aligns: Array<'left' | 'right'> = []): string {
  const widths = headers.map((h, i) => Math.max(width(h), ...rows.map((r) => width(r[i] ?? ''))));
  const align = (i: number) => aligns[i] ?? 'left';

  const lines = [
    headers.map((h, i) => dim(pad(h, widths[i]!, align(i)))).join('  '),
    dim(widths.map((w) => '─'.repeat(w)).join('──')),
    ...rows.map((r) => r.map((c, i) => pad(c ?? '', widths[i]!, align(i))).join('  ')),
  ];

  return lines.join('\n');
}

/**
 * The headline number: how much autonomous work each hour of your attention
 * produced. This is the metric the whole tool exists to surface — a traditional
 * tracker can only ever show you the focus column.
 */
function leverage(focusMs: number, agentWallMs: number): string {
  if (focusMs <= 0) return dim('—');
  return `${(agentWallMs / focusMs).toFixed(1)}×`;
}

interface Sums {
  occupancy: number;
  focus: number;
  wall: number;
  effort: number;
  prompts: number;
  subagents: number;
  idle: number;
}

function sums(rows: readonly ProjectTotalRow[]): Sums {
  return {
    occupancy: rows.reduce((s, r) => s + r.occupancy_ms, 0),
    focus: rows.reduce((s, r) => s + r.focus_ms, 0),
    wall: rows.reduce((s, r) => s + r.agent_wall_ms, 0),
    effort: rows.reduce((s, r) => s + r.agent_effort_ms, 0),
    prompts: rows.reduce((s, r) => s + r.prompt_count, 0),
    subagents: rows.reduce((s, r) => s + r.subagent_count, 0),
    idle: rows.reduce((s, r) => s + r.idle_dropped_ms, 0),
  };
}

export function renderTotals(rows: ProjectTotalRow[], range: DateRange): string {
  if (rows.length === 0) return dim(`No activity between ${range.from} and ${range.to}.`);

  const body = rows.map((r) => [
    r.project_name + (r.client ? dim(` · ${r.client}`) : ''),
    // A project marked not billable still shows its time — the work happened —
    // but dimmed, because it is excluded from the total below.
    r.billable ? green(formatDuration(r.occupancy_ms)) : dim(formatDuration(r.occupancy_ms)),
    cyan(formatDuration(r.focus_ms)),
    yellow(formatDuration(r.agent_wall_ms)),
    dim(formatDuration(r.agent_effort_ms)),
    leverage(r.focus_ms, r.agent_wall_ms),
    String(r.prompt_count),
    String(r.subagent_count),
    dim(formatDuration(r.idle_dropped_ms)),
  ]);

  const excluded = rows.filter((r) => !r.billable);

  // Two rows, each summing one population across every column.
  //
  // A single row that filtered only the BILLABLE column and left the rest
  // unfiltered reads as inconsistent, and is: a billable figure beside a focus
  // figure that includes internal projects describes two different days on one
  // line. Whichever row you read, every number on it covers the same projects.
  const all = sums(rows);
  const billable = sums(rows.filter((r) => r.billable));

  const totalRow = (label: string, s: Sums, emphasise: boolean): string[] => {
    const cell = (value: string) => (emphasise ? bold(value) : dim(value));
    return [
      cell(label),
      cell(formatDuration(s.occupancy)),
      cell(formatDuration(s.focus)),
      cell(formatDuration(s.wall)),
      cell(formatDuration(s.effort)),
      cell(leverage(s.focus, s.wall)),
      cell(String(s.prompts)),
      cell(String(s.subagents)),
      cell(formatDuration(s.idle)),
    ];
  };

  // The all-projects row is context; the billable row is the one that ends up
  // on an invoice, so it carries the emphasis — and comes last, where a total
  // is read from.
  body.push(totalRow('ALL', all, excluded.length === 0));
  if (excluded.length > 0) body.push(totalRow('BILLABLE', billable, true));

  return [
    bold(`${range.from === range.to ? range.from : `${range.from} → ${range.to}`}`),
    '',
    table(
      ['PROJECT', 'BILLABLE', 'FOCUS', 'AGENT', 'EFFORT', 'LEV', 'PR', 'SA', 'IDLE'],
      body,
      ['left', 'right', 'right', 'right', 'right', 'right', 'right', 'right', 'right'],
    ),
    '',
    excluded.length > 0
      ? dim(
          `BILLABLE row excludes ` +
            `${excluded.map((r) => `${r.project_name} (${formatDuration(r.occupancy_ms)})`).join(', ')}`,
        )
      : '',
    dim('BILLABLE wall-clock the project was worked on, by you or an agent you directed'),
    dim('         overlaps across projects — the TOTAL can exceed the day, and should'),
    dim('FOCUS    your attention only, mutually exclusive across projects'),
    dim('AGENT    wall-clock with agents running (overlap counted once)'),
    dim('EFFORT   total autonomous work (parallel agents counted separately)'),
    dim('LEV      agent wall-clock per hour of focus'),
    dim('IDLE     time discarded by the idle timeout'),
  ]
    .filter((line) => line !== '')
    .join('\n');
}

export function renderDays(rows: ProjectDayRow[]): string {
  if (rows.length === 0) return dim('No daily rows in range.');

  return table(
    ['DAY', 'PROJECT', 'FOCUS', 'AGENT', 'EFFORT', 'LEV'],
    rows.map((r) => [
      r.local_day,
      r.project_name,
      cyan(formatDuration(r.focus_ms)),
      yellow(formatDuration(r.agent_wall_ms)),
      dim(formatDuration(r.agent_effort_ms)),
      leverage(r.focus_ms, r.agent_wall_ms),
    ]),
    ['left', 'left', 'right', 'right', 'right', 'right'],
  );
}

export function renderTopics(rows: TopicRow[]): string {
  if (rows.length === 0) return dim('No topics in range.');

  return table(
    ['DAY', 'PROJECT', 'TOPIC', 'FOCUS', 'AGENT', 'PR'],
    rows.map((r) => [
      r.local_day,
      r.project_name,
      r.title.length > 52 ? `${r.title.slice(0, 51)}…` : r.title,
      cyan(formatDuration(r.focus_ms)),
      yellow(formatDuration(r.agent_wall_ms)),
      String(r.prompt_count),
    ]),
    ['left', 'left', 'left', 'right', 'right', 'right'],
  );
}

/**
 * Weekly progress against each project's arrangement.
 *
 * Caps and targets are shown together but read in opposite directions, so the
 * label states which one applies rather than leaving it to the number's sign.
 */
export function renderCommitments(statuses: CommitmentStatus[]): string {
  if (statuses.length === 0) {
    return dim('No project has a weekly commitment configured.');
  }

  const rows = statuses.map((s) => {
    const ratio = s.weeklyHours > 0 ? s.hours / s.weeklyHours : 0;
    const filled = Math.min(12, Math.round(ratio * 12));
    const bar = '█'.repeat(filled) + '░'.repeat(Math.max(0, 12 - filled));

    const note =
      s.kind === 'cap'
        ? s.breached
          ? yellow(`over by ${s.deltaHours.toFixed(2)}h`)
          : dim(`${(-s.deltaHours).toFixed(2)}h left`)
        : s.breached
          ? yellow(`short by ${(-s.deltaHours).toFixed(2)}h`)
          : dim(`${Math.max(0, -s.deltaHours).toFixed(2)}h to go`);

    return [
      s.projectName + (s.client ? dim(` · ${s.client}`) : ''),
      s.kind,
      `${s.hours.toFixed(2)} / ${s.weeklyHours}h`,
      s.breached ? yellow(bar) : green(bar),
      note,
    ];
  });

  const first = statuses[0]!;
  return [
    bold(`Week of ${first.weekStart} → ${first.weekEnd}`) + dim(`  (${Math.round(first.weekElapsed * 100)}% elapsed)`),
    '',
    table(['PROJECT', 'KIND', 'HOURS', '', ''], rows, ['left', 'left', 'right', 'left', 'left']),
    '',
    dim('cap     a ceiling — breached from above'),
    dim('target  a commitment — breached from below, judged at week end'),
  ].join('\n');
}

/**
 * Renders the timesheet grouped by week, with the cap shown per week.
 *
 * The cap is reported, never enforced. Trimming hours you actually worked is a
 * decision about a contract, not something a tracker should do quietly.
 */
export function renderTimesheet(sheet: Timesheet): string {
  const out: string[] = [
    bold(`${sheet.projectName}${sheet.client ? ` · ${sheet.client}` : ''}`),
    dim(`${sheet.range.from} → ${sheet.range.to} · basis: ${sheet.basis}`),
    '',
  ];

  for (const week of sheet.weeks) {
    const capNote =
      week.capHours === null
        ? ''
        : week.overCap
          ? yellow(`  ${week.hours.toFixed(2)}h / ${week.capHours}h  OVER by ${(week.hours - week.capHours).toFixed(2)}h`)
          : dim(`  ${week.hours.toFixed(2)}h / ${week.capHours}h`);

    out.push(bold(`Week of ${week.weekStart}`) + capNote);
    out.push(
      table(
        ['DATE', 'HOURS', 'DESCRIPTION'],
        week.entries.map((e) => [
          e.day,
          cyan(e.hours.toFixed(2)),
          e.description + (Math.abs(e.rawMs / 3_600_000 - e.hours) > 0.01 ? dim(` (raw ${toHours(e.rawMs)}h)`) : ''),
        ]),
        ['left', 'right', 'left'],
      ),
    );
    out.push('');
  }

  out.push(bold(`TOTAL  ${sheet.totalHours.toFixed(2)}h`));
  return out.join('\n');
}

/** Machine-readable form for piping into an invoicing script. */
export function renderJson(totals: ProjectTotalRow[], days: ProjectDayRow[], topicRows: TopicRow[]): string {
  return JSON.stringify(
    {
      projects: totals.map((r) => ({
        project: r.project_name,
        client: r.client,
        billable: Boolean(r.billable),
        focusHours: toHours(r.focus_ms),
        agentWallHours: toHours(r.agent_wall_ms),
        agentEffortHours: toHours(r.agent_effort_ms),
        idleDroppedHours: toHours(r.idle_dropped_ms),
        prompts: r.prompt_count,
        subagents: r.subagent_count,
        activeDays: r.active_days,
      })),
      days: days.map((r) => ({
        day: r.local_day,
        project: r.project_name,
        focusHours: toHours(r.focus_ms),
        agentWallHours: toHours(r.agent_wall_ms),
        agentEffortHours: toHours(r.agent_effort_ms),
      })),
      topics: topicRows.map((r) => ({
        day: r.local_day,
        project: r.project_name,
        title: r.title,
        focusHours: toHours(r.focus_ms),
        agentWallHours: toHours(r.agent_wall_ms),
        prompts: r.prompt_count,
      })),
    },
    null,
    2,
  );
}

#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';

import { loadConfig, configPath } from '../core/config.js';
import { loadEnvFile } from '../core/env.js';
import { listProjects, openDb } from '../core/db.js';
import { deleteExclusion, findExclusionOverlaps, insertExclusion, listExclusions } from '../core/exclude.js';
import { deleteManualEntry, findOverlaps, insertManualEntry, listManualEntries } from '../core/manual.js';
import { parseDay, parseDuration, parseTimeOfDay, toUtc } from '../core/parse.js';
import { formatDuration, localDay, localOffsetMinutes } from '../core/time.js';
import { MANUAL_KINDS, TRACKED_EVENTS, isManualKind } from '../core/types.js';
import { applyInstall, hookScriptPath, planInstall, planUninstall, settingsPath } from '../install/hooks.js';
import { aggregate } from '../aggregate/run.js';
import { reproject } from '../ingest/index.js';
import { recover } from '../ingest/recover.js';
import { commitmentStatuses } from '../report/commitments.js';
import {
  projectDays,
  projectTotals,
  prompts,
  resolveRange,
  timeline,
  topics,
  type DateRange,
} from '../report/queries.js';
import {
  renderCommitments,
  renderDays,
  renderJson,
  renderTimesheet,
  renderTopics,
  renderTotals,
  table,
} from '../report/render.js';
import {
  buildTimesheet,
  clearDayNote,
  collectDayActivity,
  currentBillingWeek,
  resolveBilling,
  saveDayNote,
  timesheetCsv,
} from '../report/timesheet.js';
import { translateLabels } from '../translate/index.js';
import { clearDaySummary, saveDaySummary, summarizeDay } from '../translate/summarize.js';
import { serve } from '../server/app.js';
import { sync } from '../sync.js';

const USAGE = `trAIcker — passive time tracking for agent orchestration

  traicker report [range] [options]   Summary by project (default: --today)
  traicker add --project X ...        Log time spent off the tools
  traicker entries [range]            List manual entries
  traicker rm <id>                    Delete a manual entry
  traicker exclude --project X ...    Correct agent time capture is known wrong
  traicker excluded [range]           List exclusions
  traicker unexclude <id>             Delete an exclusion
  traicker week                       Weekly progress against caps and targets
  traicker timesheet --project X      Billable day entries for an hourly client
  traicker note --project X --text .. Write your own line for a day (--clear removes)
  traicker translate --project X      Fill the translation cache for that project
  traicker summarize --project X      Rewrite a day's line from the whole day (--day, --clear)
  traicker topics [range] [options]   Breakdown by what you worked on
  traicker topics --detail            One row per prompt, finest view
  traicker timeline [--day D]         Raw spans for one day
  traicker serve [--port N]           Local dashboard
  traicker sync [--quiet]             Ingest spool and rebuild aggregates
  traicker projects                   List tracked projects
  traicker recover [--apply]          Rebuild events a capture failure lost
  traicker reproject                  Re-attribute history after a config change
  traicker doctor                     Prove the capture path works end to end
  traicker status                     Health check
  traicker install-hooks [--project] [--dry-run]
  traicker uninstall-hooks [--project]

Ranges:
  --today (default) --yesterday --week --month --all
  --day YYYY-MM-DD  --from YYYY-MM-DD --to YYYY-MM-DD

Options:
  --project <fragment>  Filter by project name or path
  --by-day              Also print the per-day breakdown
  --json                Machine-readable output
  --csv                 CSV output (timesheet only)
  --no-sync             Skip the automatic refresh before reading

Manual entries (meetings, research — anything that emits no events):
  traicker add --project acme --from 14:00 --to 14:30 --kind meeting --note "sprint planning"
  traicker add --project northwind --at 9am --for 45m --kind research

  Times accept 14:00, 1400 or 2pm. Durations accept 30m, 1h, 1h30m.
  A manual entry ends focus on every project for that window, and removes agent
  time on its own project so the same window is never billed twice. Agents on
  other projects keep counting — that work really happened.

Exclusions (agent time that was captured but was not real work):
  traicker exclude --project vyrve --from 21:40 --to 23:10 --note "Opus outage, agent stuck retrying"

  Only cuts agent time on that one project, for that window. Never touches
  focus, never touches other projects, adds nothing back. Use this when a
  subagent's tool call reports a long duration that was mostly the model
  provider being down, not the agent working.

Timesheet billing rules live in ~/.traicker/config.json under
projects["<path>"].billing — see config.example.json.
`;

interface Args {
  flags: Set<string>;
  values: Map<string, string>;
}

function parseArgs(argv: string[]): Args {
  const flags = new Set<string>();
  const values = new Map<string, string>();

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (!token.startsWith('--')) continue;
    const eq = token.indexOf('=');
    if (eq !== -1) {
      values.set(token.slice(2, eq), token.slice(eq + 1));
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      values.set(token.slice(2), next);
      i++;
    } else {
      flags.add(token.slice(2));
    }
  }

  return { flags, values };
}

function rangeFrom(args: Args): DateRange {
  const day = args.values.get('day');
  if (day) return { from: day, to: day };

  const from = args.values.get('from');
  const to = args.values.get('to');
  if (from || to) return { from: from ?? '0000-01-01', to: to ?? '9999-12-31' };

  for (const spec of ['today', 'yesterday', 'week', 'month', 'all'] as const) {
    if (args.flags.has(spec)) return resolveRange(spec);
  }
  return resolveRange('today');
}

/**
 * Opens the database and refreshes it first.
 *
 * The lazy refresh is what makes "zero manual action" true in practice: the
 * SessionEnd hook covers clean exits, and this covers everything else — crashed
 * sessions, sessions still running, a machine that was asleep.
 */
function openRefreshed(args: Args) {
  const config = loadConfig();
  const db = openDb(config);
  if (!args.flags.has('no-sync')) sync(db, config);
  return { config, db };
}

function report(args: Args): number {
  const { db } = openRefreshed(args);
  const range = rangeFrom(args);
  const filter = args.values.get('project');

  const totals = projectTotals(db, range, filter);
  const days = projectDays(db, range, filter);

  if (args.flags.has('json')) {
    console.log(renderJson(totals, days, topics(db, range, filter)));
    return 0;
  }

  console.log(renderTotals(totals, range));
  if (args.flags.has('by-day') && days.length > 0) {
    console.log(`\n${renderDays(days)}`);
  }
  return 0;
}

/**
 * Builds the day entries an hourly client's form expects.
 *
 * Defaults to occupancy: the wall-clock the project was being worked on, by you
 * or by an agent you directed. Billing focus alone would describe the work as
 * the few minutes of typing rather than as the thing that was delivered.
 */
function timesheetCommand(args: Args): number {
  const filter = args.values.get('project');
  if (!filter) {
    console.error('timesheet needs --project <fragment>.');
    return 1;
  }

  const { db, config } = openRefreshed(args);

  const resolved = resolveBilling(db, config, filter);
  if (!resolved) {
    console.error(`No project matching "${filter}". Try: traicker projects`);
    return 1;
  }

  // Default to the current calendar week, not a rolling seven days: the cap is
  // contractual and weekly, so a straddling window matches neither week.
  const range =
    args.values.get('day') || args.values.get('from') || hasAnyRangeFlag(args)
      ? rangeFrom(args)
      : currentBillingWeek(resolved.billing);

  const sheet = buildTimesheet(db, filter, range, resolved.billing);
  if (!sheet) {
    console.log(`No billable time for "${resolved.project.name}" between ${range.from} and ${range.to}.`);
    return 0;
  }

  if (args.flags.has('json')) {
    console.log(JSON.stringify(sheet, null, 2));
    return 0;
  }
  if (args.flags.has('csv')) {
    console.log(timesheetCsv(sheet));
    return 0;
  }

  console.log(renderTimesheet(sheet));
  if (!resolved.configured) {
    console.log(
      `\nNo billing rules configured for ${resolved.project.path}.\n` +
        `Using defaults (occupancy, 15 min rounding, no cap). See config.example.json.`,
    );
  }
  return 0;
}

/**
 * Sets or clears your own wording for one day's timesheet line.
 *
 * The generated text is a draft; a line a client reads deserves a human pass,
 * and this is where you take it.
 */
function noteCommand(args: Args): number {
  const filter = args.values.get('project');
  if (!filter) {
    console.error('note needs --project <fragment>.');
    return 1;
  }

  const config = loadConfig();
  const db = openDb(config);

  const resolved = resolveBilling(db, config, filter);
  if (!resolved) {
    console.error(`No project matching "${filter}". Try: traicker projects`);
    return 1;
  }

  const day = parseDay(args.values.get('day') ?? 'today');
  if (!day) {
    console.error('Could not read --day. Use YYYY-MM-DD, today or yesterday.');
    return 1;
  }

  if (args.flags.has('clear')) {
    const removed = clearDayNote(db, resolved.project.id, day);
    console.log(removed ? `Cleared the note for ${day}.` : `No note on ${day}.`);
    return 0;
  }

  const text = args.values.get('text');
  if (!text) {
    const existing = db
      .prepare('SELECT note FROM timesheet_notes WHERE local_day = ? AND project_id = ?')
      .get(day, resolved.project.id) as { note: string } | undefined;
    console.log(existing ? existing.note : `No note on ${day}. Set one with --text "...".`);
    return 0;
  }

  saveDayNote(db, resolved.project.id, day, text.trim());
  console.log(`${resolved.project.name} ${day}: ${text.trim()}`);
  return 0;
}

/**
 * Fills the translation cache for a project's labels.
 *
 * A deliberate step rather than something a report triggers: it costs money and
 * touches the network, and neither belongs on the path that renders a number
 * you are about to read.
 */
async function translateCommand(args: Args): Promise<number> {
  const filter = args.values.get('project');
  if (!filter) {
    console.error('translate needs --project <fragment>.');
    return 1;
  }

  const { db, config } = openRefreshed(args);

  const resolved = resolveBilling(db, config, filter);
  if (!resolved) {
    console.error(`No project matching "${filter}". Try: traicker projects`);
    return 1;
  }

  const target = args.values.get('to') ?? resolved.billing.translateTo;
  if (!target) {
    console.error(
      `No target language. Set billing.translateTo for ${resolved.project.name} in config, or pass --to English.`,
    );
    return 1;
  }

  const range =
    args.values.get('from') || args.values.get('day') || hasAnyRangeFlag(args)
      ? rangeFrom(args)
      : currentBillingWeek(resolved.billing);

  const labels = (
    db
      .prepare(
        `SELECT DISTINCT t.title
         FROM daily_topics t
         JOIN projects p ON p.id = t.project_id
         WHERE t.local_day BETWEEN ? AND ?
           AND p.id = ?
           AND t.title_source IN ('manual', 'task', 'session_title')`,
      )
      .all(range.from, range.to, resolved.project.id) as Array<{ title: string }>
  ).map((r) => r.title);

  if (labels.length === 0) {
    console.log(`Nothing to translate for ${resolved.project.name} between ${range.from} and ${range.to}.`);
    return 0;
  }

  console.log(`Translating ${labels.length} label(s) to ${target} using ${config.translationModel}…`);
  const result = await translateLabels(db, config, labels, target);

  console.log(`  already cached: ${result.fromCache}`);
  console.log(`  translated now: ${result.translated}`);
  if (result.failed > 0) console.log(`  failed:         ${result.failed}`);
  if (result.error) {
    console.error(`\n${result.error}`);
    console.error('Untranslated labels keep their original wording — the timesheet still works.');
    return 1;
  }

  console.log('\nCached by source string, so re-running costs nothing and the wording never drifts.');
  return 0;
}

/**
 * Rewrites one day's timesheet description from that whole day's activity.
 *
 * The generated description joins session titles, and Claude Code names a
 * session once, from its opening minutes — a day of many tasks inside one long
 * session therefore reports the name of the first. This asks a model to read
 * the day's prompts instead.
 *
 * Explicit and per-day for the same reason `translate` is: it costs money, it
 * sends your prompt text to the API, and the result is stored so the wording of
 * a line you already read never changes underneath you.
 */
async function summarizeCommand(args: Args): Promise<number> {
  const filter = args.values.get('project');
  if (!filter) {
    console.error('summarize needs --project <fragment>.');
    return 1;
  }

  const { db, config } = openRefreshed(args);

  const resolved = resolveBilling(db, config, filter);
  if (!resolved) {
    console.error(`No project matching "${filter}". Try: traicker projects`);
    return 1;
  }

  const day = parseDay(args.values.get('day') ?? 'today');
  if (!day) {
    console.error('Could not read --day. Use YYYY-MM-DD, today or yesterday.');
    return 1;
  }

  if (args.flags.has('clear')) {
    const removed = clearDaySummary(db, resolved.project.id, day);
    console.log(removed ? `Cleared the summary for ${day}.` : `No summary on ${day}.`);
    return 0;
  }

  const activity = collectDayActivity(db, resolved.project.id, day);
  if (activity.titles.length === 0 && activity.excerpts.length === 0) {
    console.log(`No activity recorded for ${resolved.project.name} on ${day}.`);
    return 0;
  }

  console.log(
    `Summarising ${day} for ${resolved.project.name} from ` +
      `${activity.excerpts.length} prompt(s) and ${activity.titles.length} title(s) using ${config.translationModel}…`,
  );

  const result = await summarizeDay(config, activity, resolved.billing.translateTo);
  if (result.summary === null) {
    console.error(`\n${result.error ?? 'could not summarise that day'}`);
    console.error('The existing description is unchanged.');
    return 1;
  }

  saveDaySummary(db, resolved.project.id, day, result, config.translationModel, resolved.billing.translateTo ?? null);

  console.log(`\n${result.summary}\n`);
  console.log(`Stored. Overrides the generated line for ${day}; your own \`traicker note\` still wins.`);
  return 0;
}

function hasAnyRangeFlag(args: Args): boolean {
  return ['today', 'yesterday', 'week', 'month', 'all'].some((spec) => args.flags.has(spec));
}

function topicsCommand(args: Args): number {
  const { db } = openRefreshed(args);
  const range = rangeFrom(args);
  const filter = args.values.get('project');

  // --detail drops to one row per prompt. Topics group by declared task or
  // session title; per-prompt labels are too fine to group by but are the right
  // granularity for reading a day back.
  if (args.flags.has('detail') || args.flags.has('by-prompt')) {
    const rows = prompts(db, range, filter);
    if (args.flags.has('json')) {
      console.log(JSON.stringify(rows, null, 2));
      return 0;
    }
    if (rows.length === 0) {
      console.log('No prompts in range.');
      return 0;
    }

    console.log(
      table(
        ['TIME', 'PROJECT', 'SRC', 'WHAT'],
        rows.map((r) => [
          `${r.ts_utc.slice(5, 10)} ${r.ts_utc.slice(11, 16)}`,
          r.project_name,
          r.source,
          (r.label ?? '—').slice(0, 90),
        ]),
      ),
    );
    console.log('\nTimes are UTC. One row per prompt.');
    return 0;
  }

  const rows = topics(db, range, filter);
  if (args.flags.has('json')) {
    console.log(renderJson([], [], rows));
    return 0;
  }

  console.log(renderTopics(rows));
  return 0;
}

function timelineCommand(args: Args): number {
  const { db } = openRefreshed(args);
  const range = rangeFrom(args);
  const rows = timeline(db, { from: range.from, to: range.from }, args.values.get('project'));

  if (args.flags.has('json')) {
    console.log(JSON.stringify(rows, null, 2));
    return 0;
  }

  if (rows.length === 0) {
    console.log(`No spans on ${range.from}.`);
    return 0;
  }

  console.log(
    table(
      ['START', 'END', 'BUCKET', 'SOURCE', 'PROJECT', 'DUR', 'TOPIC'],
      rows.map((r) => [
        r.start_utc.slice(11, 19),
        r.end_utc.slice(11, 19),
        r.bucket,
        r.source,
        r.project_name,
        formatDuration(r.duration_ms),
        (r.agent_type ? `[${r.agent_type}] ` : '') + (r.title ?? ''),
      ]),
      ['left', 'left', 'left', 'left', 'left', 'right', 'left'],
    ),
  );
  console.log('\nTimes are UTC.');
  return 0;
}

function syncCommand(args: Args): number {
  const config = loadConfig();
  const db = openDb(config);
  const result = sync(db, config);

  if (!args.flags.has('quiet')) {
    console.log(
      `ingested ${result.ingest.eventsInserted} events from ${result.ingest.filesScanned} spool file(s)` +
        ` (${result.ingest.duplicatesSkipped} duplicate, ${result.ingest.badLines} bad)`,
    );
    console.log(`rebuilt ${result.aggregate.daysRebuilt.length} day(s), ${result.aggregate.spansWritten} spans`);
  }
  return 0;
}

/**
 * Re-attributes historical events after a project-resolution change.
 *
 * Needed because project id is the one derived value stored on `events`; adding
 * a project to config does not otherwise reach work already recorded under a
 * parent directory.
 */
/**
 * Repairs a window where capture was broken, from the session transcripts.
 *
 * Defaults to a dry run: this writes into the event log, and seeing what would
 * change before it changes is worth one extra flag.
 */
function recoverCommand(args: Args): number {
  const config = loadConfig();
  const db = openDb(config);

  const apply = args.flags.has('apply');
  const range = args.values.get('from') || args.values.get('to') ? rangeFrom(args) : undefined;

  const result = recover(db, config, {
    from: range?.from,
    to: range?.to,
    dryRun: !apply,
  });

  if (result.promptsRecovered === 0) {
    console.log(`Scanned ${result.transcriptsScanned} transcript(s). Nothing to recover.`);
    return 0;
  }

  console.log(`${apply ? 'Recovered' : 'Would recover'} ${result.promptsRecovered} prompt(s) and ${result.stopsRecovered} turn end(s):\n`);
  console.log(
    table(
      ['SESSION', 'PROJECT', 'PROMPTS', 'FROM', 'TO'],
      result.sessions.map((s) => [
        s.sessionId.slice(0, 8),
        s.projectName,
        String(s.prompts),
        s.firstUtc.slice(0, 19).replace('T', ' '),
        s.lastUtc.slice(0, 19).replace('T', ' '),
      ]),
      ['left', 'left', 'right', 'left', 'left'],
    ),
  );
  console.log('\nTimes are UTC.');

  if (!apply) {
    console.log('\nDry run — nothing written. Re-run with --apply.');
    return 0;
  }

  const agg = aggregate(db, config, {});
  console.log(`\nRebuilt ${agg.daysRebuilt.length} day(s).`);
  console.log(`Recovered events are marked source='transcript' and are excluded from "hook" counts in status.`);
  return 0;
}

function reprojectCommand(args: Args): number {
  const config = loadConfig();
  const db = openDb(config);

  const result = reproject(db, config);
  console.log(`scanned ${result.eventsScanned} events, moved ${result.eventsMoved}`);
  for (const move of result.moves) {
    console.log(`  ${move.from} -> ${move.to}  (${move.count} events)`);
  }
  if (result.orphansRemoved > 0) console.log(`removed ${result.orphansRemoved} empty project(s)`);

  if (result.eventsMoved > 0 || args.flags.has('force')) {
    // Full rebuild: attribution changed, so no day can be assumed unaffected.
    const agg = aggregate(db, config, {});
    console.log(`rebuilt ${agg.daysRebuilt.length} day(s), ${agg.spansWritten} spans`);
  }
  return 0;
}

/**
 * Logs work that produced no events — meetings, research, anything off the
 * tools. The one place manual input is unavoidable: nothing observed it.
 */
function addCommand(args: Args): number {
  const filter = args.values.get('project');
  if (!filter) {
    console.error('add needs --project <fragment>.');
    return 1;
  }

  const config = loadConfig();
  const db = openDb(config);

  const project = listProjects(db).find(
    (p) =>
      p.name.toLowerCase().includes(filter.toLowerCase()) || p.path.toLowerCase().includes(filter.toLowerCase()),
  );
  if (!project) {
    console.error(`No project matching "${filter}". Try: traicker projects`);
    return 1;
  }

  const offset = localOffsetMinutes();
  const dayInput = args.values.get('day') ?? (args.flags.has('yesterday') ? 'yesterday' : 'today');
  const day = parseDay(dayInput);
  if (!day) {
    console.error(`Could not read --day "${dayInput}". Use YYYY-MM-DD, today or yesterday.`);
    return 1;
  }

  const fromInput = args.values.get('from') ?? args.values.get('at');
  if (!fromInput) {
    console.error('add needs --from <time> (or --at).');
    return 1;
  }
  const fromMinutes = parseTimeOfDay(fromInput);
  if (fromMinutes === null) {
    console.error(`Could not read the time "${fromInput}". Try 14:00, 1400 or 2pm.`);
    return 1;
  }

  let endMinutes: number | null = null;
  const toInput = args.values.get('to');
  const forInput = args.values.get('for') ?? args.values.get('duration');

  if (toInput) {
    endMinutes = parseTimeOfDay(toInput);
    if (endMinutes === null) {
      console.error(`Could not read the time "${toInput}". Try 14:30, 1430 or 2:30pm.`);
      return 1;
    }
    // A window ending before it starts crossed midnight.
    if (endMinutes <= fromMinutes) endMinutes += 24 * 60;
  } else if (forInput) {
    const minutes = parseDuration(forInput);
    if (minutes === null) {
      console.error(`Could not read the duration "${forInput}". Try 30m, 1h or 1h30m.`);
      return 1;
    }
    endMinutes = fromMinutes + minutes;
  } else {
    console.error('add needs --to <time> or --for <duration>.');
    return 1;
  }

  const kindInput = args.values.get('kind') ?? 'other';
  if (!isManualKind(kindInput)) {
    console.error(`Unknown --kind "${kindInput}". One of: ${MANUAL_KINDS.join(', ')}`);
    return 1;
  }

  const startUtc = toUtc(day, fromMinutes, offset);
  const endUtc = toUtc(day, endMinutes, offset);

  const overlaps = findOverlaps(db, startUtc, endUtc);
  if (overlaps.length > 0 && !args.flags.has('force')) {
    console.error('That window overlaps existing manual time:\n');
    for (const conflict of overlaps) {
      console.error(
        `  #${conflict.entry.id}  ${conflict.entry.start_utc.slice(11, 16)}-${conflict.entry.end_utc.slice(11, 16)} UTC` +
          `  ${conflict.projectName}  ${conflict.entry.note ?? conflict.entry.kind}`,
      );
    }
    console.error('\nManual time is exclusive — you cannot be in two places at once.');
    console.error('Fix the times, or pass --force if the overlap is intentional.');
    return 1;
  }

  const note = args.values.get('note') ?? null;
  const entry = insertManualEntry(db, {
    projectId: project.id,
    startUtc,
    endUtc,
    tzOffsetMin: offset,
    kind: kindInput,
    note,
  });

  const minutes = Math.round((endUtc - startUtc) / 60_000);
  console.log(
    `#${entry.id}  ${project.name}  ${day} ${formatMinutes(fromMinutes)}-${formatMinutes(endMinutes)} local` +
      `  (${formatDuration(minutes * 60_000)})  ${kindInput}${note ? ` — ${note}` : ''}`,
  );

  const result = sync(db, config);
  console.log(`\nRebuilt ${result.aggregate.daysRebuilt.length} day(s).`);

  // Say what was displaced, rather than leaving the numbers to move silently.
  console.log(
    `Focus on other projects is cut for this window; agent time on ${project.name} is cut too, ` +
      `so the same window is not billed twice.`,
  );
  return 0;
}

function entriesCommand(args: Args): number {
  const { db } = openRefreshed(args);
  const range = args.flags.has('today') || hasAnyRangeFlag(args) ? rangeFrom(args) : resolveRange('week');
  const rows = listManualEntries(db, range.from, range.to);

  if (args.flags.has('json')) {
    console.log(JSON.stringify(rows, null, 2));
    return 0;
  }

  if (rows.length === 0) {
    console.log(`No manual entries between ${range.from} and ${range.to}.`);
    return 0;
  }

  console.log(
    table(
      ['ID', 'DAY', 'TIME', 'DUR', 'PROJECT', 'KIND', 'NOTE'],
      rows.map((r) => {
        const start = Date.parse(r.start_utc) + r.tz_offset_min * 60_000;
        const end = Date.parse(r.end_utc) + r.tz_offset_min * 60_000;
        return [
          `#${r.id}`,
          new Date(start).toISOString().slice(0, 10),
          `${new Date(start).toISOString().slice(11, 16)}-${new Date(end).toISOString().slice(11, 16)}`,
          formatDuration(end - start),
          r.project_name,
          r.kind,
          r.note ?? '—',
        ];
      }),
      ['left', 'left', 'left', 'right', 'left', 'left', 'left'],
    ),
  );
  console.log('\nTimes are local.');
  return 0;
}

function rmCommand(args: Args): number {
  const raw = args.values.get('id') ?? process.argv[3];
  const id = Number(String(raw ?? '').replace('#', ''));
  if (!Number.isInteger(id) || id <= 0) {
    console.error('rm needs an entry id. Try: traicker entries');
    return 1;
  }

  const config = loadConfig();
  const db = openDb(config);

  const removed = deleteManualEntry(db, id);
  if (!removed) {
    console.error(`No manual entry #${id}.`);
    return 1;
  }

  console.log(`Removed #${id} (${removed.kind}${removed.note ? ` — ${removed.note}` : ''}).`);
  sync(db, config);
  console.log('Rebuilt. Displaced time is back.');
  return 0;
}

/**
 * Corrects the record when automatic capture is known wrong: a subagent
 * dispatched into a model outage sits retrying under the hood, then reports
 * back through an ordinary successful tool call whose `duration_ms` covers
 * the whole stretch. Nothing in the hook payload tells that time apart from
 * real work, so this is the only way to zero it out.
 *
 * Unlike `add`, this never adds anything back and never touches focus or
 * other projects — it says "this captured window was not real work", not
 * "here is what I was doing instead".
 */
function excludeCommand(args: Args): number {
  const filter = args.values.get('project');
  if (!filter) {
    console.error('exclude needs --project <fragment>.');
    return 1;
  }

  const config = loadConfig();
  const db = openDb(config);

  const project = listProjects(db).find(
    (p) =>
      p.name.toLowerCase().includes(filter.toLowerCase()) || p.path.toLowerCase().includes(filter.toLowerCase()),
  );
  if (!project) {
    console.error(`No project matching "${filter}". Try: traicker projects`);
    return 1;
  }

  const offset = localOffsetMinutes();
  const dayInput = args.values.get('day') ?? (args.flags.has('yesterday') ? 'yesterday' : 'today');
  const day = parseDay(dayInput);
  if (!day) {
    console.error(`Could not read --day "${dayInput}". Use YYYY-MM-DD, today or yesterday.`);
    return 1;
  }

  const fromInput = args.values.get('from') ?? args.values.get('at');
  if (!fromInput) {
    console.error('exclude needs --from <time> (or --at).');
    return 1;
  }
  const fromMinutes = parseTimeOfDay(fromInput);
  if (fromMinutes === null) {
    console.error(`Could not read the time "${fromInput}". Try 14:00, 1400 or 2pm.`);
    return 1;
  }

  let endMinutes: number | null = null;
  const toInput = args.values.get('to');
  const forInput = args.values.get('for') ?? args.values.get('duration');

  if (toInput) {
    endMinutes = parseTimeOfDay(toInput);
    if (endMinutes === null) {
      console.error(`Could not read the time "${toInput}". Try 14:30, 1430 or 2:30pm.`);
      return 1;
    }
    if (endMinutes <= fromMinutes) endMinutes += 24 * 60;
  } else if (forInput) {
    const minutes = parseDuration(forInput);
    if (minutes === null) {
      console.error(`Could not read the duration "${forInput}". Try 30m, 1h or 1h30m.`);
      return 1;
    }
    endMinutes = fromMinutes + minutes;
  } else {
    console.error('exclude needs --to <time> or --for <duration>.');
    return 1;
  }

  const startUtc = toUtc(day, fromMinutes, offset);
  const endUtc = toUtc(day, endMinutes, offset);

  const overlaps = findExclusionOverlaps(db, project.id, startUtc, endUtc);
  if (overlaps.length > 0 && !args.flags.has('force')) {
    console.error(`That window already overlaps an exclusion on ${project.name}:\n`);
    for (const conflict of overlaps) {
      console.error(
        `  #${conflict.entry.id}  ${conflict.entry.start_utc.slice(11, 16)}-${conflict.entry.end_utc.slice(11, 16)} UTC` +
          `  ${conflict.entry.note ?? '(no note)'}`,
      );
    }
    console.error('\nPass --force if the overlap is intentional.');
    return 1;
  }

  const note = args.values.get('note') ?? null;
  const entry = insertExclusion(db, {
    projectId: project.id,
    startUtc,
    endUtc,
    tzOffsetMin: offset,
    note,
  });

  const minutes = Math.round((endUtc - startUtc) / 60_000);
  console.log(
    `#${entry.id}  ${project.name}  ${day} ${formatMinutes(fromMinutes)}-${formatMinutes(endMinutes)} local` +
      `  (${formatDuration(minutes * 60_000)})${note ? ` — ${note}` : ''}`,
  );

  const result = sync(db, config);
  console.log(`\nRebuilt ${result.aggregate.daysRebuilt.length} day(s).`);
  console.log(`Agent time on ${project.name} is cut for this window. Nothing else changes.`);
  return 0;
}

function excludedCommand(args: Args): number {
  const { db } = openRefreshed(args);
  const range = args.flags.has('today') || hasAnyRangeFlag(args) ? rangeFrom(args) : resolveRange('week');
  const rows = listExclusions(db, range.from, range.to);

  if (args.flags.has('json')) {
    console.log(JSON.stringify(rows, null, 2));
    return 0;
  }

  if (rows.length === 0) {
    console.log(`No exclusions between ${range.from} and ${range.to}.`);
    return 0;
  }

  console.log(
    table(
      ['ID', 'DAY', 'TIME', 'DUR', 'PROJECT', 'NOTE'],
      rows.map((r) => {
        const start = Date.parse(r.start_utc) + r.tz_offset_min * 60_000;
        const end = Date.parse(r.end_utc) + r.tz_offset_min * 60_000;
        return [
          `#${r.id}`,
          new Date(start).toISOString().slice(0, 10),
          `${new Date(start).toISOString().slice(11, 16)}-${new Date(end).toISOString().slice(11, 16)}`,
          formatDuration(end - start),
          r.project_name,
          r.note ?? '—',
        ];
      }),
      ['left', 'left', 'left', 'right', 'left', 'left'],
    ),
  );
  console.log('\nTimes are local. Agent time only — focus is never touched by an exclusion.');
  return 0;
}

function unexcludeCommand(args: Args): number {
  const raw = args.values.get('id') ?? process.argv[3];
  const id = Number(String(raw ?? '').replace('#', ''));
  if (!Number.isInteger(id) || id <= 0) {
    console.error('unexclude needs an entry id. Try: traicker excluded');
    return 1;
  }

  const config = loadConfig();
  const db = openDb(config);

  const removed = deleteExclusion(db, id);
  if (!removed) {
    console.error(`No exclusion #${id}.`);
    return 1;
  }

  console.log(`Removed #${id}${removed.note ? ` — ${removed.note}` : ''}.`);
  sync(db, config);
  console.log('Rebuilt. The window counts again.');
  return 0;
}

/** `870` -> `14:30`, for echoing back what was understood. */
function formatMinutes(minutesOfDay: number): string {
  const normalised = minutesOfDay % (24 * 60);
  const hours = Math.floor(normalised / 60);
  return `${String(hours).padStart(2, '0')}:${String(normalised % 60).padStart(2, '0')}`;
}

function commitmentsCommand(args: Args): number {
  const { db, config } = openRefreshed(args);
  const statuses = commitmentStatuses(db, config);

  if (args.flags.has('json')) {
    console.log(JSON.stringify(statuses, null, 2));
    return 0;
  }

  console.log(renderCommitments(statuses));
  return 0;
}

function projectsCommand(): number {
  const config = loadConfig();
  const db = openDb(config);
  const rows = listProjects(db);

  if (rows.length === 0) {
    console.log('No projects tracked yet.');
    return 0;
  }

  console.log(
    table(
      ['NAME', 'CLIENT', 'BILLABLE', 'PATH'],
      rows.map((r) => [r.name, r.client ?? '—', r.billable ? 'yes' : 'no', r.path]),
    ),
  );
  return 0;
}

/**
 * Proves the capture path still works, end to end.
 *
 * The hook is built to fail silently so it can never wedge a session — which
 * also means a broken hook looks exactly like an idle afternoon. This is the
 * counterweight: it writes a probe through the real binary and checks it landed.
 */
function doctorCommand(): number {
  const config = loadConfig();
  const hookPath = hookScriptPath();
  let failures = 0;

  const check = (label: string, ok: boolean, detail = ''): void => {
    if (!ok) failures++;
    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
  };

  check('hook binary exists', existsSync(hookPath), hookPath);

  const settings = settingsPath('user');
  let registered: string[] = [];
  try {
    const parsed = JSON.parse(readFileSync(settings, 'utf8')) as { hooks?: Record<string, unknown> };
    registered = TRACKED_EVENTS.filter((event) => {
      const entries = parsed.hooks?.[event];
      return (
        Array.isArray(entries) &&
        entries.some(
          (m) =>
            typeof m === 'object' &&
            m !== null &&
            Array.isArray((m as { hooks?: unknown[] }).hooks) &&
            (m as { hooks: Array<{ command?: string }> }).hooks.some((h) => h.command?.includes('traicker')),
        )
      );
    });
  } catch {
    /* reported below */
  }
  check(
    'hooks registered',
    registered.length === TRACKED_EVENTS.length,
    `${registered.length}/${TRACKED_EVENTS.length}` +
      (registered.length < TRACKED_EVENTS.length
        ? ` missing: ${TRACKED_EVENTS.filter((e) => !registered.includes(e)).join(', ')}`
        : ''),
  );

  // Run the real hook, on a real project path, and see whether a line appears.
  const probeSession = `doctor-${Date.now()}`;
  const probeCwd = listProjects(db2(config)).at(0)?.path ?? process.cwd();
  const payload = JSON.stringify({
    session_id: probeSession,
    cwd: probeCwd,
    hook_event_name: 'SessionStart',
    source: 'startup',
  });

  const run = spawnSync(process.execPath, [hookPath], { input: payload, encoding: 'utf8', timeout: 10_000 });
  check('hook exits cleanly', run.status === 0, `exit ${run.status}`);
  if (run.stdout && run.stdout.length > 0) {
    check('hook writes nothing to stdout', false, 'stdout would be injected into your prompt');
  } else {
    check('hook writes nothing to stdout', true);
  }

  const day = localDay(Date.now(), localOffsetMinutes());
  const probeFile = path.join(config.spoolDir, day, `${probeSession}.ndjson`);
  const landed = existsSync(probeFile);
  check('probe reached the spool', landed, landed ? probeFile : `expected ${probeFile}`);
  if (landed) rmSync(probeFile, { force: true });

  // Silence is the failure mode that looks like success, so name it.
  const db = db2(config);
  const last = db.prepare('SELECT MAX(ts_utc) AS t FROM events').get() as { t: string | null };
  if (last.t) {
    const ageMin = Math.round((Date.now() - Date.parse(last.t)) / 60_000);
    console.log(`\nlast event: ${last.t} (${ageMin} min ago)`);
    if (ageMin > 120) {
      console.log('Note: over two hours of silence. Normal if you were away — suspicious if you were not.');
    }
  } else {
    console.log('\nNo events captured yet.');
  }

  console.log(failures === 0 ? '\nCapture path is healthy.' : `\n${failures} check(s) failed.`);
  return failures === 0 ? 0 : 1;
}

/** Opens the database without triggering a sync. */
function db2(config: ReturnType<typeof loadConfig>) {
  return openDb(config);
}

/**
 * Whether a model key is available, and where it came from.
 *
 * Never prints the value. Shows the last four characters only, which is enough
 * to tell two keys apart when one of them has been revoked.
 */
function describeKey(): string {
  const env = ENV;
  const key = process.env['OPENROUTER_API_KEY'];

  if (!key || key.trim().length === 0) {
    return env.found
      ? `missing — ${env.file} exists but sets no OPENROUTER_API_KEY`
      : `missing — create ${env.file} with OPENROUTER_API_KEY=sk-or-v1-...`;
  }

  const tail = `…${key.slice(-4)}`;
  if (env.skipped.includes('OPENROUTER_API_KEY')) return `${tail} (from the environment, overriding ${env.file})`;
  if (env.applied.includes('OPENROUTER_API_KEY')) return `${tail} (from ${env.file})`;
  return `${tail} (from the environment)`;
}

function statusCommand(): number {
  const config = loadConfig();
  const db = openDb(config);

  const events = db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number };
  const first = db.prepare('SELECT MIN(ts_utc) AS t FROM events').get() as { t: string | null };
  const last = db.prepare('SELECT MAX(ts_utc) AS t FROM events').get() as { t: string | null };
  const byType = db
    .prepare('SELECT event_type, COUNT(*) AS n FROM events GROUP BY event_type ORDER BY n DESC')
    .all() as Array<{ event_type: string; n: number }>;
  const cursors = db.prepare('SELECT COUNT(*) AS n, SUM(bad_lines) AS bad FROM spool_cursor').get() as {
    n: number;
    bad: number | null;
  };

  console.log(`config:  ${configPath()}`);
  console.log(`db:      ${config.dbPath}`);
  console.log(`spool:   ${config.spoolDir}`);
  console.log(`idle:    ${config.idleTimeoutMinutes} min`);
  console.log(`model:   ${config.translationModel}`);
  console.log(`key:     ${describeKey()}\n`);
  console.log(`events:  ${events.n}${first.t ? ` (${first.t} → ${last.t})` : ''}`);

  // Reconstructed events are real work but were inferred, not observed. Saying
  // so unprompted is the difference between a record and a guess.
  const recovered = db.prepare(`SELECT COUNT(*) AS n FROM events WHERE source = 'transcript'`).get() as { n: number };
  if (recovered.n > 0) {
    console.log(`         ${recovered.n} reconstructed from transcripts (source='transcript')`);
  }
  console.log(`spool:   ${cursors.n} file(s) tracked, ${cursors.bad ?? 0} bad line(s)`);
  console.log(`projects: ${listProjects(db).length}\n`);

  if (byType.length > 0) {
    console.log(table(['EVENT', 'COUNT'], byType.map((r) => [r.event_type, String(r.n)]), ['left', 'right']));
  }
  return 0;
}

function install(args: Args): number {
  const target = settingsPath(args.flags.has('project') ? 'project' : 'user');
  const plan = planInstall(target, hookScriptPath());

  console.log(`settings: ${plan.settingsPath}`);
  console.log(`hook:     node "${plan.hookScript}"\n`);
  console.log(`  added:     ${plan.added.join(', ') || '(none)'}`);
  console.log(`  replaced:  ${plan.replaced.join(', ') || '(none)'}`);
  console.log(`  unchanged: ${plan.unchanged.join(', ') || '(none)'}`);

  if (plan.added.length === 0 && plan.replaced.length === 0) {
    console.log('\nAlready up to date.');
    return 0;
  }

  if (args.flags.has('dry-run')) {
    console.log(`\n--- resulting settings.json ---\n${plan.after}\nDry run: nothing written.`);
    return 0;
  }

  const backup = applyInstall(plan);
  console.log(`\nWritten. ${backup ? `Backup: ${backup}` : 'No previous file to back up.'}`);
  console.log('Restart any running Claude Code sessions to pick the hooks up.');
  return 0;
}

function uninstall(args: Args): number {
  const plan = planUninstall(settingsPath(args.flags.has('project') ? 'project' : 'user'));
  if (plan.replaced.length === 0) {
    console.log('No trAIcker hooks found.');
    return 0;
  }
  const backup = applyInstall(plan);
  console.log(`Removed from: ${plan.replaced.join(', ')}`);
  if (backup) console.log(`Backup: ${backup}`);
  return 0;
}

/** Commands that need to await I/O. Kept separate so the rest stay synchronous. */
async function asyncMain(command: string, args: Args): Promise<number | null> {
  if (command === 'translate') return translateCommand(args);
  if (command === 'summarize' || command === 'summarise') return summarizeCommand(args);
  return null;
}

function main(): number {
  const [command = 'report', ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);

  switch (command) {
    case 'note':
      return noteCommand(args);
    case 'report':
      return report(args);
    case 'timesheet':
      return timesheetCommand(args);
    case 'topics':
      return topicsCommand(args);
    case 'timeline':
      return timelineCommand(args);
    case 'serve': {
      const port = Number(args.values.get('port'));
      serve(Number.isFinite(port) && port > 0 ? port : undefined);
      return -1; // long-running: do not exit
    }
    case 'sync':
      return syncCommand(args);
    case 'add':
      return addCommand(args);
    case 'entries':
      return entriesCommand(args);
    case 'rm':
      return rmCommand(args);
    case 'exclude':
      return excludeCommand(args);
    case 'excluded':
      return excludedCommand(args);
    case 'unexclude':
      return unexcludeCommand(args);
    case 'commitments':
    case 'week':
      return commitmentsCommand(args);
    case 'recover':
      return recoverCommand(args);
    case 'reproject':
      return reprojectCommand(args);
    case 'projects':
      return projectsCommand();
    case 'doctor':
      return doctorCommand();
    case 'status':
      return statusCommand();
    case 'install-hooks':
      return install(args);
    case 'uninstall-hooks':
      return uninstall(args);
    case 'help':
    case '--help':
    case '-h':
      console.log(USAGE);
      return 0;
    default:
      console.error(`Unknown command: ${command}\n${USAGE}`);
      return 1;
  }
}

/**
 * Credentials, before anything dispatches.
 *
 * Loaded here rather than inside `main()` because async commands are routed
 * first — and `translate` and `summarize`, the only two that need a key, are
 * exactly those. Kept so `status` can report where the key came from without
 * reading the file a second time and mistaking its own work for the shell's.
 */
const ENV = loadEnvFile();

const [invoked = 'report', ...invokedArgs] = process.argv.slice(2);

asyncMain(invoked, parseArgs(invokedArgs))
  .then((asyncCode) => {
    if (asyncCode !== null) return asyncCode;
    const code = main();
    // -1 means a long-running command took over the process (the dashboard).
    return code === -1 ? null : code;
  })
  .then((code) => {
    if (code !== null) process.exit(code);
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });

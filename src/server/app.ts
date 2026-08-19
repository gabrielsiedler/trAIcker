import express, { type Request, type Response } from 'express';
import { existsSync, statSync } from 'node:fs';
import type { Server } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  billingFor,
  commitmentFor,
  configPath,
  isHexColor,
  loadConfig,
  type BillingConfig,
  type CommitmentConfig,
  type TraickerConfig,
} from '../core/config.js';
import { updateProjectConfig, type ProjectPatch } from '../core/config-writer.js';
import { listProjects, openDb, refreshProjectMetadata, type Db } from '../core/db.js';
import { deleteExclusion, findExclusionOverlaps, insertExclusion, listExclusions } from '../core/exclude.js';
import { deleteManualEntry, findOverlaps, insertManualEntry, listManualEntries } from '../core/manual.js';
import { parseDay, parseDuration, parseTimeOfDay, toUtc } from '../core/parse.js';
import { localDay, localOffsetMinutes, toHours, toMs, WEEK_START_DAYS, type WeekStart } from '../core/time.js';
import { isManualKind } from '../core/types.js';
import { dailyCostTotals, modelUsageTotals, projectCostTotals } from '../report/cost.js';
import { projectDays, projectTotals, resolveRange, timeline, type DateRange } from '../report/queries.js';
import {
  buildTimesheet,
  clearDayNote,
  collectDayActivity,
  currentBillingWeek,
  resolveBilling,
  saveDayNote,
} from '../report/timesheet.js';
import { clearDaySummary, saveDaySummary, summarizeDay } from '../translate/summarize.js';
import { sync } from '../sync.js';

/** Debounce so a page with several panels triggers one refresh, not four. */
const SYNC_MIN_INTERVAL_MS = 10_000;

/** Mtime of config.json, or 0 when it is absent. Cheap enough to poll. */
function configFileMtime(): number {
  try {
    return statSync(configPath()).mtimeMs;
  } catch {
    return 0;
  }
}

export function createApp(db: Db, initialConfig: TraickerConfig) {
  const app = express();
  app.use(express.json({ limit: '64kb' }));

  // Reloaded after a config write, and whenever the file changes underneath us.
  let config = initialConfig;
  let configMtime = configFileMtime();
  let lastSync = 0;

  /**
   * Picks up hand edits to config.json.
   *
   * The server applies its config to the database on every sync, so holding a
   * stale copy does not merely serve old values — it actively rewrites project
   * settings back to what they were when the process started, silently undoing
   * whatever was edited in the file meanwhile.
   */
  const reloadConfigIfChanged = (): void => {
    const mtime = configFileMtime();
    if (mtime === configMtime) return;
    configMtime = mtime;
    try {
      config = loadConfig();
      refreshProjectMetadata(db, config.projects);
    } catch {
      /* keep the last good config */
    }
  };

  /**
   * Refreshes before serving, at most once per interval.
   *
   * The dashboard must reflect sessions that are still running, which the
   * SessionEnd hook cannot cover — so reads pull rather than wait to be pushed.
   * Failures are swallowed: stale data beats a broken page.
   */
  const refresh = (): void => {
    reloadConfigIfChanged();

    const now = Date.now();
    if (now - lastSync < SYNC_MIN_INTERVAL_MS) return;
    lastSync = now;
    try {
      sync(db, config);
    } catch {
      /* serve what we have */
    }
  };

  const rangeOf = (req: Request): DateRange => {
    const from = typeof req.query['from'] === 'string' ? req.query['from'] : null;
    const to = typeof req.query['to'] === 'string' ? req.query['to'] : null;
    if (from && to) return { from, to };

    const spec = typeof req.query['range'] === 'string' ? req.query['range'] : 'today';
    if (spec === 'today' || spec === 'yesterday' || spec === 'week' || spec === 'month' || spec === 'all') {
      return resolveRange(spec);
    }
    return resolveRange('today');
  };

  const projectOf = (req: Request): string | undefined =>
    typeof req.query['project'] === 'string' && req.query['project'].length > 0 ? req.query['project'] : undefined;

  app.get('/api/summary', (req: Request, res: Response) => {
    refresh();
    const range = rangeOf(req);
    const filter = projectOf(req);

    const costByProject = new Map(projectCostTotals(db, range, config, filter).map((c) => [c.project_id, c]));
    const costByDay = new Map(
      dailyCostTotals(db, range, config, filter).map((c) => [`${c.local_day} ${c.project_id}`, c]),
    );

    res.json({
      range,
      totals: projectTotals(db, range, filter)
        .map(withHours)
        .map((row) => withCost(row, costByProject.get(row.project_id))),
      days: projectDays(db, range, filter)
        .map(withHours)
        .map((row) => withCost(row, costByDay.get(`${row.local_day} ${row.project_id}`))),
    });
  });

  /**
   * Spans for the strip, over whatever range the page is showing.
   *
   * `day` still works and is treated as a one-day range, so a bookmarked URL or
   * an older client keeps working.
   */
  app.get('/api/timeline', (req: Request, res: Response) => {
    refresh();
    const day = typeof req.query['day'] === 'string' ? req.query['day'] : null;
    const range = day ? { from: day, to: day } : rangeOf(req);
    res.json({ range, spans: timeline(db, range, projectOf(req)) });
  });

  /**
   * Token usage and estimated spend per model, over a range.
   *
   * Internal/dashboard-only — never reachable from the client-facing
   * timesheet routes below, since it reads daily_model_usage rather than
   * daily_summary/daily_topics.
   */
  app.get('/api/models', (req: Request, res: Response) => {
    refresh();
    const range = rangeOf(req);
    const models = modelUsageTotals(db, range, config, projectOf(req));
    res.json({
      range,
      models,
      unpriced: [...new Set(models.filter((m) => m.cost_usd === null).map((m) => m.model))],
    });
  });

  /**
   * Projects, each flagged with whether it has billing rules.
   *
   * The dashboard uses the flag to decide whether to offer a timesheet at all —
   * a project without a billing block is tracked for visibility and must never
   * appear as something invoiceable.
   */
  app.get('/api/projects', (_req: Request, res: Response) => {
    res.json({
      projects: listProjects(db).map((project) => ({
        ...project,
        hasBilling: billingFor(config, project.path) !== null,
      })),
    });
  });

  /**
   * Day entries for an hourly client's form.
   *
   * Defaults to the current week because the cap is weekly — that is the unit
   * actually being checked against before anything gets submitted.
   */
  app.get('/api/timesheet', (req: Request, res: Response) => {
    refresh();

    const filter = typeof req.query['project'] === 'string' ? req.query['project'] : '';
    if (filter.length === 0) {
      res.status(400).json({ error: 'project is required' });
      return;
    }

    const resolved = resolveBilling(db, config, filter);
    if (!resolved) {
      res.status(404).json({ error: `no project matching "${filter}"` });
      return;
    }

    const from = typeof req.query['from'] === 'string' ? req.query['from'] : null;
    const to = typeof req.query['to'] === 'string' ? req.query['to'] : null;
    // Calendar week, not a rolling seven days — the cap is weekly and
    // contractual, so a straddling window matches neither week.
    const range = from && to ? { from, to } : currentBillingWeek(resolved.billing);

    res.json({
      project: resolved.project.name,
      client: resolved.project.client,
      configured: resolved.configured,
      billing: resolved.billing,
      range,
      sheet: buildTimesheet(db, filter, range, resolved.billing),
    });
  });

  /**
   * Full project settings, including the blocks the read-only list omitted.
   *
   * `configured` says whether the project has an entry in config.json at all —
   * the dashboard needs to distinguish "set to these values" from "defaulted".
   */
  app.get('/api/projects/settings', (_req: Request, res: Response) => {
    res.json({
      configPath: configPath(),
      projects: listProjects(db).map((project) => {
        const override = config.projects[project.path_key];
        return {
          ...project,
          configured: override !== undefined,
          commitment: commitmentFor(config, project.path),
          billing: billingFor(config, project.path),
        };
      }),
    });
  });

  /**
   * Writes project settings through to config.json.
   *
   * The file stays the source of truth so hand edits keep working, which is why
   * this goes to disk rather than to a table.
   */
  app.patch('/api/projects/:id', (req: Request, res: Response) => {
    const project = listProjects(db).find((p) => String(p.id) === req.params['id']);
    if (!project) {
      res.status(404).json({ error: 'no such project' });
      return;
    }

    const body = req.body as Record<string, unknown>;
    const patch: ProjectPatch = {};

    if (typeof body['name'] === 'string' && body['name'].trim().length > 0) patch.name = body['name'].trim();
    if (typeof body['client'] === 'string') patch.client = body['client'].trim() || null;
    else if (body['client'] === null) patch.client = null;
    if (typeof body['billable'] === 'boolean') patch.billable = body['billable'];

    // Validated here as well as on load: this string ends up in a style
    // attribute, and the request does not have to come from the dashboard.
    if (body['color'] === null) patch.color = null;
    else if (typeof body['color'] === 'string') {
      if (!isHexColor(body['color'])) {
        res.status(400).json({ error: 'color must be a hex value like #3fb950' });
        return;
      }
      patch.color = body['color'].toLowerCase();
    }

    if ('commitment' in body) patch.commitment = parseCommitmentBody(body['commitment']);
    if ('billing' in body) patch.billing = parseBillingBody(body['billing'], billingFor(config, project.path));

    try {
      const backup = updateProjectConfig(project.path, patch);
      // Reload and push the new labels into the database in one step, so the
      // dashboard reflects the change on its next read rather than the next
      // time an event happens to arrive for that project.
      config = loadConfig();
      configMtime = configFileMtime();
      refreshProjectMetadata(db, config.projects);
      lastSync = 0;
      res.json({ ok: true, backup });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get('/api/entries', (req: Request, res: Response) => {
    const range = rangeOf(req);
    res.json({ range, entries: listManualEntries(db, range.from, range.to) });
  });

  /**
   * Logs work that produced no events.
   *
   * Times are parsed server-side with the same code the CLI uses, so the two
   * surfaces cannot drift on what `2pm` or `1h30m` means.
   */
  app.post('/api/entries', (req: Request, res: Response) => {
    const body = req.body as Record<string, unknown>;

    const project = listProjects(db).find((p) => String(p.id) === String(body['projectId']));
    if (!project) {
      res.status(400).json({ error: 'unknown project' });
      return;
    }

    const day = parseDay(typeof body['day'] === 'string' ? body['day'] : 'today');
    if (!day) {
      res.status(400).json({ error: 'could not read the day' });
      return;
    }

    const fromMinutes = parseTimeOfDay(String(body['from'] ?? ''));
    if (fromMinutes === null) {
      res.status(400).json({ error: 'could not read the start time — try 14:00, 1400 or 2pm' });
      return;
    }

    let endMinutes: number | null = null;
    if (typeof body['to'] === 'string' && body['to'].trim().length > 0) {
      endMinutes = parseTimeOfDay(body['to']);
      if (endMinutes === null) {
        res.status(400).json({ error: 'could not read the end time' });
        return;
      }
      if (endMinutes <= fromMinutes) endMinutes += 24 * 60; // crossed midnight
    } else if (typeof body['duration'] === 'string' && body['duration'].trim().length > 0) {
      const minutes = parseDuration(body['duration']);
      if (minutes === null) {
        res.status(400).json({ error: 'could not read the duration — try 30m, 1h or 1h30m' });
        return;
      }
      endMinutes = fromMinutes + minutes;
    } else {
      res.status(400).json({ error: 'need an end time or a duration' });
      return;
    }

    const kind = isManualKind(body['kind']) ? body['kind'] : 'other';
    const offset = localOffsetMinutes();
    const startUtc = toUtc(day, fromMinutes, offset);
    const endUtc = toUtc(day, endMinutes, offset);

    const overlaps = findOverlaps(db, startUtc, endUtc);
    if (overlaps.length > 0 && body['force'] !== true) {
      res.status(409).json({
        error: 'overlaps existing manual time',
        conflicts: overlaps.map((c) => ({
          id: c.entry.id,
          project: c.projectName,
          start: c.entry.start_utc,
          end: c.entry.end_utc,
          note: c.entry.note,
        })),
      });
      return;
    }

    const note = typeof body['note'] === 'string' && body['note'].trim().length > 0 ? body['note'].trim() : null;
    const entry = insertManualEntry(db, {
      projectId: project.id,
      startUtc,
      endUtc,
      tzOffsetMin: offset,
      kind,
      note,
    });

    // A cached day-summary predating this entry describes a day that no
    // longer matches what happened — it must not keep winning over the
    // (now more accurate) generated description just because it was asked
    // for first. See readDaySummary's priority over the joined titles.
    clearDaySummary(db, project.id, day);

    // The entry itself produced no event, so sync()'s own affected-days list
    // never includes `day` unless it happens to be today or yesterday — a
    // meeting logged for last week would otherwise sit in the database
    // unaggregated until something else rebuilds that day.
    const entryDays = new Set([
      localDay(toMs(entry.start_utc), entry.tz_offset_min),
      localDay(toMs(entry.end_utc), entry.tz_offset_min),
    ]);
    sync(db, config, [...entryDays]);
    lastSync = Date.now();
    res.json({ ok: true, entry });
  });

  app.delete('/api/entries/:id', (req: Request, res: Response) => {
    const removed = deleteManualEntry(db, Number(req.params['id']));
    if (!removed) {
      res.status(404).json({ error: 'no such entry' });
      return;
    }

    clearDaySummary(db, removed.project_id, localDay(toMs(removed.start_utc), removed.tz_offset_min));

    // Same reasoning as the insert path: removing the entry is itself not an
    // event, so its day(s) must be named explicitly or a backdated meeting's
    // removal never reaches that day's spans.
    const removedDays = new Set([
      localDay(toMs(removed.start_utc), removed.tz_offset_min),
      localDay(toMs(removed.end_utc), removed.tz_offset_min),
    ]);
    sync(db, config, [...removedDays]);
    lastSync = Date.now();
    res.json({ ok: true });
  });

  app.get('/api/exclusions', (req: Request, res: Response) => {
    const range = rangeOf(req);
    res.json({ range, exclusions: listExclusions(db, range.from, range.to) });
  });

  /**
   * Corrects agent time capture that is known wrong (an agent stuck retrying
   * through an outage, for example) — cuts the agent bucket only, in the
   * exclusion's own project, and never touches focus. See `traicker exclude`,
   * which this mirrors, and `applyExclusions` in `aggregate/displace.ts` for
   * where the cut is actually applied.
   *
   * Timestamps are the span's own ISO strings, sent verbatim from the
   * timeline click — no day/time-of-day parsing needed here, unlike a typed
   * manual entry.
   */
  app.post('/api/exclusions', (req: Request, res: Response) => {
    const body = req.body as Record<string, unknown>;

    const project = listProjects(db).find((p) => String(p.id) === String(body['projectId']));
    if (!project) {
      res.status(400).json({ error: 'unknown project' });
      return;
    }

    const startUtc = Date.parse(String(body['startUtc'] ?? ''));
    const endUtc = Date.parse(String(body['endUtc'] ?? ''));
    if (!Number.isFinite(startUtc) || !Number.isFinite(endUtc) || endUtc <= startUtc) {
      res.status(400).json({ error: 'invalid time window' });
      return;
    }

    const overlaps = findExclusionOverlaps(db, project.id, startUtc, endUtc);
    if (overlaps.length > 0 && body['force'] !== true) {
      res.status(409).json({
        error: 'overlaps existing exclusion',
        conflicts: overlaps.map((c) => ({
          id: c.entry.id,
          start: c.entry.start_utc,
          end: c.entry.end_utc,
          note: c.entry.note,
        })),
      });
      return;
    }

    const note = typeof body['note'] === 'string' && body['note'].trim().length > 0 ? body['note'].trim() : null;
    const offset = localOffsetMinutes();
    const entry = insertExclusion(db, {
      projectId: project.id,
      startUtc,
      endUtc,
      tzOffsetMin: offset,
      note,
    });

    const entryDays = new Set([localDay(startUtc, offset), localDay(endUtc, offset)]);
    sync(db, config, [...entryDays]);
    lastSync = Date.now();
    res.json({ ok: true, entry });
  });

  app.delete('/api/exclusions/:id', (req: Request, res: Response) => {
    const removed = deleteExclusion(db, Number(req.params['id']));
    if (!removed) {
      res.status(404).json({ error: 'no such exclusion' });
      return;
    }

    const removedDays = new Set([
      localDay(toMs(removed.start_utc), removed.tz_offset_min),
      localDay(toMs(removed.end_utc), removed.tz_offset_min),
    ]);
    sync(db, config, [...removedDays]);
    lastSync = Date.now();
    res.json({ ok: true });
  });

  /**
   * Rewrites one day's timesheet description from that whole day's activity.
   *
   * The generated description joins session titles, and Claude Code names a
   * session once, from its opening minutes — so a day of many tasks inside one
   * long session reports the name of the first. This asks a model to read the
   * day instead. It is a deliberate, per-day action rather than something that
   * happens on render: it costs money, it leaves the machine, and a billing
   * line must not silently reword itself between reading and submitting.
   */
  app.post('/api/timesheet/summary', async (req: Request, res: Response) => {
    // No refresh() here: this rewrites a day from data already ingested by
    // the page's own GETs, and sync() is a blocking ingest+aggregate pass —
    // running it on the same click that's about to wait ~60s on the model
    // stacks two slow things and reads as a frozen dashboard.
    const body = (req.body ?? {}) as Record<string, unknown>;
    const filter = typeof body['project'] === 'string' ? body['project'] : '';
    const day = typeof body['day'] === 'string' ? body['day'] : '';

    if (filter.length === 0 || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      res.status(400).json({ error: 'project and day (YYYY-MM-DD) are required' });
      return;
    }

    const resolved = resolveBilling(db, config, filter);
    if (!resolved) {
      res.status(404).json({ error: `no project matching "${filter}"` });
      return;
    }

    const activity = collectDayActivity(db, resolved.project.id, day);
    const result = await summarizeDay(config, activity, resolved.billing.translateTo);

    if (result.summary === null) {
      // 502 rather than 500: the failure is upstream, and the dashboard shows
      // the reason verbatim so a missing key reads as a missing key.
      res.status(502).json({ error: result.error ?? 'could not summarise that day' });
      return;
    }

    saveDaySummary(db, resolved.project.id, day, result, config.translationModel, resolved.billing.translateTo ?? null);

    res.json({
      ok: true,
      day,
      summary: result.summary,
      inputKind: result.inputKind,
      inputCount: result.inputCount,
    });
  });

  /** Drops a stored summary, returning the day to its joined-titles description. */
  app.delete('/api/timesheet/summary', (req: Request, res: Response) => {
    const filter = typeof req.query['project'] === 'string' ? req.query['project'] : '';
    const day = typeof req.query['day'] === 'string' ? req.query['day'] : '';

    const resolved = filter.length > 0 ? resolveBilling(db, config, filter) : null;
    if (!resolved || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      res.status(400).json({ error: 'project and day (YYYY-MM-DD) are required' });
      return;
    }

    res.json({ ok: true, removed: clearDaySummary(db, resolved.project.id, day) });
  });

  /**
   * Sets your own wording for one day's line — the last word on a billing
   * line a client actually reads, and the only path that beats a rewrite.
   */
  app.post('/api/timesheet/note', (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const filter = typeof body['project'] === 'string' ? body['project'] : '';
    const day = typeof body['day'] === 'string' ? body['day'] : '';
    const text = typeof body['text'] === 'string' ? body['text'].trim() : '';

    if (filter.length === 0 || !/^\d{4}-\d{2}-\d{2}$/.test(day) || text.length === 0) {
      res.status(400).json({ error: 'project, day (YYYY-MM-DD), and non-empty text are required' });
      return;
    }

    const resolved = resolveBilling(db, config, filter);
    if (!resolved) {
      res.status(404).json({ error: `no project matching "${filter}"` });
      return;
    }

    saveDayNote(db, resolved.project.id, day, text);
    res.json({ ok: true, day, note: text });
  });

  /** Drops a manual note, returning the day to its generated or rewritten description. */
  app.delete('/api/timesheet/note', (req: Request, res: Response) => {
    const filter = typeof req.query['project'] === 'string' ? req.query['project'] : '';
    const day = typeof req.query['day'] === 'string' ? req.query['day'] : '';

    const resolved = filter.length > 0 ? resolveBilling(db, config, filter) : null;
    if (!resolved || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      res.status(400).json({ error: 'project and day (YYYY-MM-DD) are required' });
      return;
    }

    res.json({ ok: true, removed: clearDayNote(db, resolved.project.id, day) });
  });

  app.get('/api/health', (_req: Request, res: Response) => {
    const events = db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number };
    res.json({ ok: true, events: events.n, dbPath: config.dbPath, idleTimeoutMinutes: config.idleTimeoutMinutes });
  });

  // The built SPA. Absent in dev, where Vite serves the frontend and proxies
  // /api here.
  const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');
  if (existsSync(webRoot)) {
    app.use(express.static(webRoot));
    app.get(/^(?!\/api\/).*/, (_req: Request, res: Response) => {
      res.sendFile(path.join(webRoot, 'index.html'));
    });
  }

  return app;
}

function parseWeekStart(value: unknown, fallback: WeekStart): WeekStart {
  return typeof value === 'string' && (WEEK_START_DAYS as readonly string[]).includes(value)
    ? (value as WeekStart)
    : fallback;
}

/** `null` clears the block; anything unreadable leaves it alone. */
function parseCommitmentBody(raw: unknown): CommitmentConfig | null | undefined {
  if (raw === null) return null;
  if (typeof raw !== 'object') return undefined;

  const c = raw as Record<string, unknown>;
  const hours = Number(c['weeklyHours']);
  if (!Number.isFinite(hours) || hours <= 0) return null;

  return {
    weeklyHours: hours,
    kind: c['kind'] === 'target' ? 'target' : 'cap',
    weekStartsOn: parseWeekStart(c['weekStartsOn'], 'monday'),
  };
}

/**
 * Applies a billing edit on top of what is already on disk.
 *
 * Merged rather than rebuilt from a whitelist. Rebuilding silently deleted
 * every field the dashboard's form does not render — `translateTo` among them,
 * so changing a project's colour destroyed the rule that keeps that client's
 * timesheet in English, and nothing said so. Any field this function does not
 * know about is a field the user put there on purpose.
 *
 * `translateTo: null` still clears it, so the form can remove one deliberately.
 */
export function parseBillingBody(raw: unknown, current: BillingConfig | null): BillingConfig | null | undefined {
  if (raw === null) return null;
  if (typeof raw !== 'object') return undefined;

  const b = raw as Record<string, unknown>;
  const rounding = Number(b['roundToMinutes']);

  const merged: BillingConfig = {
    ...(current ?? {}),
    basis: b['basis'] === 'focus' ? 'focus' : 'occupancy',
    roundToMinutes: Number.isFinite(rounding) && rounding >= 1 ? Math.min(60, Math.floor(rounding)) : 15,
    weekStartsOn: parseWeekStart(b['weekStartsOn'], 'monday'),
    allowExcerpts: b['allowExcerpts'] === true,
  };

  if (typeof b['translateTo'] === 'string' && b['translateTo'].trim().length > 0) {
    merged.translateTo = b['translateTo'].trim();
  } else if (b['translateTo'] === null) {
    delete merged.translateTo;
  }

  return merged;
}

/** Adds decimal-hour fields so the client never re-derives them. */
function withHours<T extends object>(row: T): T & Record<string, unknown> {
  const source = row as Record<string, unknown>;
  const out: Record<string, unknown> = { ...source };
  for (const key of ['focus_ms', 'agent_wall_ms', 'agent_effort_ms', 'occupancy_ms', 'idle_dropped_ms']) {
    const value = source[key];
    if (typeof value === 'number') out[`${key.replace(/_ms$/, '')}_hours`] = toHours(value);
  }
  return out as T & Record<string, unknown>;
}

/**
 * Folds an estimated-spend row onto a totals/day row, keyed by whatever the
 * caller already matched on (project, or project+day).
 *
 * `cost` is undefined for a project/day with no `daily_model_usage` rows at
 * all — distinct from `cost_usd: null`, which means usage existed but no
 * price was effective yet. Both surface as `null` to the client; the two
 * cases aren't worth distinguishing in the UI, which just shows "—" either way.
 */
function withCost<T extends object>(
  row: T,
  cost: { cost_usd: number | null; partiallyPriced: boolean } | undefined,
): T & { cost_usd: number | null; cost_partially_priced: boolean } {
  return {
    ...row,
    cost_usd: cost?.cost_usd ?? null,
    cost_partially_priced: cost?.partiallyPriced ?? false,
  };
}

/** A started dashboard server and the handles its owner needs to shut it down. */
export interface RunningServer {
  server: Server;
  db: Db;
  config: TraickerConfig;
  port: number;
}

/**
 * Starts the dashboard and hands back its parts, without deciding what a
 * failure means.
 *
 * Split out of `serve` for the desktop app, which embeds this in its main
 * process: there, a port already in use is not fatal — it usually means the
 * user's own CLI server is up, and pointing the window at it is better than
 * refusing to launch. The CLI keeps the opposite policy in `serve`.
 *
 * Binds on every interface (no host argument), which is what makes the
 * dashboard reachable from a phone over Tailscale rather than from this
 * machine only.
 */
export function startServer(port?: number): RunningServer {
  const config = loadConfig();
  const db = openDb(config);
  const listenPort = port ?? config.serverPort;
  const server = createApp(db, config).listen(listenPort);

  // Node's default is 5 minutes — long enough that a dropped connection during
  // an LLM call (up to 60s, see TIMEOUT_MS in summarize.ts) reads as the redo
  // button hanging forever rather than failing. Force-close well past that but
  // still under the client's own abort timeout, so either side reports it.
  server.requestTimeout = 100_000;

  return { server, db, config, port: listenPort };
}

export function serve(port?: number): void {
  const { server, config, port: listenPort } = startServer(port);

  server.on('listening', () => {
    console.log(`trAIcker dashboard: http://localhost:${listenPort}`);
    console.log(`database: ${config.dbPath}`);
  });

  // Failing to bind used to exit quietly, leaving an older server answering on
  // that port — which looks exactly like a working dashboard until a route it
  // has never heard of returns 404.
  server.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`Port ${listenPort} is already in use — most likely an older trAIcker server.`);
      console.error(`It will answer requests but not know about anything added since it started.`);
      console.error(`Stop it, or run with --port <n>.`);
    } else {
      console.error(`Could not start the dashboard: ${error.message}`);
    }
    process.exit(1);
  });
}

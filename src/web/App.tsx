import { useCallback, useEffect, useState } from 'react';

import {
  api,
  formatDuration,
  leverage,
  num,
  todayLocal,
  type BillableProject,
  type DateRange,
  type ModelUsage,
  type ProjectDay,
  type ProjectTotal,
  type RangeQuery,
  type RangeSpec,
  type TimelineSpan,
} from './api.js';
import { DayMatrix } from './components/DayMatrix.js';
import { EntryForm } from './components/EntryForm.js';
import { ModelsPanel } from './components/ModelsPanel.js';
import { ProjectsPanel } from './components/ProjectsPanel.js';
import { TimelineStrip, type BillableFilter } from './components/TimelineStrip.js';
import { TimesheetPanel } from './components/TimesheetPanel.js';

type RangeMode = RangeSpec | 'custom';

/* Labels are short because this is a segmented control in a 46px toolbar now,
   not a row of buttons with a full line to itself. */
const RANGES: Array<{ id: RangeMode; label: string }> = [
  { id: 'today', label: 'Today' },
  { id: 'yesterday', label: 'Yesterday' },
  { id: 'week', label: '7 days' },
  { id: 'month', label: '30 days' },
  { id: 'all', label: 'All' },
  { id: 'custom', label: 'Custom' },
];

type TabId = 'overview' | 'timesheet' | 'projects' | 'models' | 'entries';

interface View {
  id: TabId;
  label: string;
  /** Reads the toolbar's range. */
  usesRange: boolean;
  /** Reads the sidebar's project selection. */
  usesProject: boolean;
}

/**
 * The source list's upper group — the views, in the order they are worked in,
 * each declaring which of the two global selectors it actually reads.
 *
 * A selector a view ignores is disabled while that view is open. A control
 * that looks live and changes nothing is worse than one that is visibly out
 * of play: the first invites you to conclude the data is wrong, the second
 * tells you where the real control is.
 *
 * Projects sits in this group rather than at the foot of the project list
 * because the two are different kinds of thing: the list below chooses what
 * the other views are *about*, while this one is where a project's own
 * settings are edited.
 */
const VIEWS: View[] = [
  { id: 'overview', label: 'Overview', usesRange: true, usesProject: true },
  // Owns a project select and a week nav of its own, so both global selectors
  // would be a second, contradicting way to ask the same question.
  { id: 'timesheet', label: 'Timesheet', usesRange: false, usesProject: false },
  // Edits the projects themselves, so narrowing to one would hide the rest —
  // but its per-project figures are still a function of the range.
  { id: 'projects', label: 'Projects', usesRange: true, usesProject: false },
  { id: 'models', label: 'Models', usesRange: true, usesProject: true },
  // The form carries its own project field; the list below it is the range.
  { id: 'entries', label: 'Entries', usesRange: true, usesProject: false },
];

/** The view on screen, so the toolbar and sidebar can grey out what it ignores. */
const VIEW_BY_ID = new Map(VIEWS.map((v) => [v.id, v]));

const VIEW_TITLES: Record<TabId, string> = {
  overview: 'Overview',
  timesheet: 'Timesheet',
  projects: 'Projects',
  models: 'Models',
  entries: 'Time off the tools',
};

const FILTERS: Array<{ id: BillableFilter; label: string }> = [
  { id: 'billable', label: 'Billable' },
  { id: 'other', label: 'Non-billable' },
  { id: 'all', label: 'All' },
];

/** Poll interval. The server syncs on read, so this keeps a live day current. */
const REFRESH_MS = 60_000;

export function App() {
  // Every piece of view state is component state. Nothing is persisted to
  // localStorage or sessionStorage.
  const [tab, setTab] = useState<TabId>('overview');
  const [rangeMode, setRangeMode] = useState<RangeMode>('today');
  const [customFrom, setCustomFrom] = useState(todayLocal());
  const [customTo, setCustomTo] = useState(todayLocal());
  const [totals, setTotals] = useState<ProjectTotal[]>([]);
  const [days, setDays] = useState<ProjectDay[]>([]);
  const [loadedRange, setLoadedRange] = useState<DateRange | null>(null);
  const [spans, setSpans] = useState<TimelineSpan[]>([]);
  const [models, setModels] = useState<ModelUsage[]>([]);
  const [unpricedModels, setUnpricedModels] = useState<string[]>([]);
  const [laneFilter, setLaneFilter] = useState<BillableFilter>('billable');
  const [projects, setProjects] = useState<BillableProject[]>([]);
  /** Project name the whole window is narrowed to, or null for everything. */
  const [scope, setScope] = useState<string | null>(null);
  /**
   * Totals for every project, ignoring `scope`.
   *
   * Two consumers need this rather than the scoped `totals`: the source list,
   * which must keep listing every project while the views are narrowed to one
   * (otherwise picking a project empties the list you picked it from), and the
   * Projects view, which edits settings and so is about the projects
   * themselves rather than about whatever is currently selected.
   */
  const [allTotals, setAllTotals] = useState<ProjectTotal[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  /** First paint only: there is nothing on screen yet, so show skeletons. */
  const [loading, setLoading] = useState(true);
  /**
   * A refetch with content already on screen.
   *
   * Separate from `loading` because the two want opposite treatments: with
   * nothing rendered yet the honest thing is a skeleton, but replacing a
   * populated dashboard with skeletons every time the range changes would
   * throw away readable data and flash the layout. This keeps the stale
   * figures visible, dimmed, under a progress bar.
   */
  const [refreshing, setRefreshing] = useState(false);

  // Project list changes rarely, so it is fetched once rather than on every
  // range change like the panels below.
  const loadProjects = useCallback(() => {
    api
      .projects()
      .then((response) => setProjects(response.projects))
      .catch(() => setProjects([]));
  }, []);

  useEffect(loadProjects, [loadProjects]);

  const windowQuery: RangeQuery =
    rangeMode === 'custom' ? { from: customFrom, to: customTo } : { range: rangeMode };
  const scopedQuery: RangeQuery = scope ? { ...windowQuery, project: scope } : windowQuery;

  /**
   * `silent` is for the background poll. The server syncs on read, so a poll
   * can take the same second or two as a real refetch — but the user did not
   * ask for it, and a progress bar that appears on its own every minute reads
   * as the page doing something to you rather than for you.
   */
  const load = useCallback(async (silent = false) => {
    if (!silent) setRefreshing(true);
    try {
      const [summary, timeline, modelUsage, unscoped] = await Promise.all([
        api.summary(scopedQuery),
        api.timeline(scopedQuery),
        api.models(scopedQuery),
        // Only when narrowed: unscoped, this is the same request twice.
        scope ? api.summary(windowQuery) : Promise.resolve(null),
      ]);

      setTotals(summary.totals);
      setDays(summary.days);
      setLoadedRange(summary.range);
      setSpans(timeline.spans);
      setModels(modelUsage.models);
      setUnpricedModels(modelUsage.unpriced);
      setAllTotals(unscoped ? unscoped.totals : summary.totals);
      // Detected by absence rather than by a version handshake: the field is
      // simply not in the payload of a server built before it existed.
      setStale(summary.totals.length > 0 && summary.totals.every((t) => t.occupancy_ms === undefined));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [rangeMode, customFrom, customTo, scope]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(true), REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  // What the view on screen actually listens to. Falls back to "listens to
  // everything" so an unlisted view degrades to the old behaviour rather than
  // to a dashboard whose controls are all dead.
  const view = VIEW_BY_ID.get(tab);
  const usesRange = view?.usesRange ?? true;
  const usesProject = view?.usesProject ?? true;
  const rangeNote = usesRange ? undefined : `${VIEW_TITLES[tab]} has its own date controls`;
  const projectNote = usesProject ? undefined : `${VIEW_TITLES[tab]} is not filtered by project`;

  // Billable projects only — see ProjectTable for why.
  const totalBillable = totals.reduce((sum, t) => sum + (t.billable ? num(t.occupancy_ms) : 0), 0);
  const excludedNames = totals.filter((t) => !t.billable).map((t) => t.project_name);
  const totalFocus = totals.reduce((sum, t) => sum + num(t.focus_ms), 0);
  const totalWall = totals.reduce((sum, t) => sum + num(t.agent_wall_ms), 0);
  const totalEffort = totals.reduce((sum, t) => sum + num(t.agent_effort_ms), 0);

  const hasBilling = projects.some((p) => p.hasBilling);

  // Summed over the unscoped list on purpose, so the "All projects" row keeps
  // showing the whole day while a single project is selected.
  const allOccupancy = allTotals.reduce((sum, t) => sum + num(t.occupancy_ms), 0);

  // Even two consecutive worked days stop being readable as one gantt — the
  // axis has to show a day boundary and the hour together, and two days' worth
  // of spans on one 900px strip already crowds a lane. So the day becomes the
  // unit as soon as there's more than one. Decided on the data rather than on
  // the picked range, because a week with one working day in it is still a day.
  const distinctDays = new Set(days.map((d) => d.local_day)).size;
  const byDay = distinctDays > 1;

  return (
    <div className="app">
      {/* The window's own bar: what you are looking at on the left, over what
          period on the right. The app's name is not here — the window title,
          the dock icon and the tray already carry it, and this row is the
          scarcest horizontal space in the layout. */}
      <div className="toolbar">
        <h1>
          {VIEW_TITLES[tab]}
          {scope && tab !== 'projects' && <span className="scope"> — {scope}</span>}
        </h1>
        <div className="toolbar-right">
          {rangeMode === 'custom' && (
            <div className="custom-range" data-inert={usesRange ? undefined : 'true'}>
              <input
                type="date"
                value={customFrom}
                max={customTo}
                disabled={!usesRange}
                onChange={(event) => setCustomFrom(event.target.value)}
              />
              <span>–</span>
              <input
                type="date"
                value={customTo}
                min={customFrom}
                disabled={!usesRange}
                onChange={(event) => setCustomTo(event.target.value)}
              />
            </div>
          )}
          {/* Kept mounted and showing its selection while inert, rather than
              hidden: the range is still what Overview will show when you go
              back, and a control that vanishes per view teaches nothing about
              which views it drives. `title` says why on hover — a disabled
              control with no reason is the frustrating kind. */}
          <div
            className="range-seg"
            role="group"
            aria-label="Range"
            data-inert={usesRange ? undefined : 'true'}
            title={rangeNote}
          >
            {RANGES.map((r) => (
              <button
                key={r.id}
                className={r.id === rangeMode ? 'active' : ''}
                aria-pressed={r.id === rangeMode}
                disabled={!usesRange}
                onClick={() => setRangeMode(r.id)}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>
        {/* Sits on the toolbar's bottom edge and is always in the DOM, so
            starting a refetch never shifts the layout by a pixel. Announced
            politely rather than assertively: it reports that the numbers below
            are being replaced, which is not worth interrupting anyone for. */}
        <div className={refreshing ? 'progress busy' : 'progress'} role="status" aria-live="polite">
          {refreshing && <span className="sr-only">Loading…</span>}
        </div>
      </div>

      <nav className="sidebar" aria-label="Sections and projects">
        <div className="side-group">Views</div>
        {VIEWS.map((v) => (
          <button
            key={v.id}
            className={v.id === tab ? 'side-item active' : 'side-item'}
            aria-current={v.id === tab ? 'page' : undefined}
            onClick={() => setTab(v.id)}
          >
            <span className="side-label">{v.label}</span>
          </button>
        ))}

        {/* The hours stay readable while the group is inert — they are a fact
            about the range, not about the selection, and they are the reason
            to glance at this list even from a view that ignores it. */}
        <div className="side-group" data-inert={usesProject ? undefined : 'true'}>
          Projects
        </div>
        {/* "All projects" is a row rather than a clear-selection button so that
            the scope always has something checked — a list where nothing is
            selected reads as broken rather than as unfiltered. */}
        <button
          className={scope === null ? 'side-item active' : 'side-item'}
          aria-current={scope === null ? 'true' : undefined}
          disabled={!usesProject}
          title={projectNote}
          onClick={() => setScope(null)}
        >
          <span className="side-label">All projects</span>
          <span className="side-count">{formatShort(allOccupancy)}</span>
        </button>
        {allTotals.map((p) => (
          <button
            key={p.project_id}
            className={scope === p.project_name ? 'side-item active' : 'side-item'}
            aria-current={scope === p.project_name ? 'true' : undefined}
            disabled={!usesProject}
            onClick={() => setScope(p.project_name)}
            title={projectNote ?? (p.client ? `${p.project_name} — ${p.client}` : p.project_name)}
          >
            <span className="side-dot" style={p.color ? { background: p.color } : undefined} />
            <span className="side-label">{p.project_name}</span>
            <span className="side-count">{formatShort(num(p.occupancy_ms))}</span>
          </button>
        ))}
      </nav>

      {/* Dimmed rather than replaced: the figures are a moment stale, not
          gone, and keeping them legible is what stops a slow refetch from
          reading as a frozen window. */}
      <main className="content" data-refreshing={refreshing ? 'true' : undefined}>
      {error && <div className="error">Could not reach the API: {error}</div>}

      {/* A `traicker serve` left running from an older build answers happily and
          silently omits newer fields. Saying so beats showing plausible zeros. */}
      {stale && (
        <div className="error">
          The server is running an older build — billable time is missing from its responses. Restart{' '}
          <code>traicker serve</code> to pick up the current one.
        </div>
      )}

      {tab === 'overview' && (
        <div>
          {/* Before the first response every total is 0, which renders as a
              confident "0h 00m" — a real-looking figure that happens to be
              wrong. Skeletons say "not yet" instead of lying. */}
          {loading ? (
            <StatsSkeleton count={5} />
          ) : (
          <section className="stats">
            <Stat
              label="Billable"
              value={formatDuration(totalBillable)}
              hint={
                excludedNames.length > 0
                  ? `billable projects only — excludes ${excludedNames.join(', ')}`
                  : 'worked on by you or an agent — overlaps across projects'
              }
              tone="billable"
            />
            <Stat label="Focus" value={formatDuration(totalFocus)} hint="your attention, never double-counted" />
            <Stat label="Agent wall-clock" value={formatDuration(totalWall)} hint="overlap counted once" />
            <Stat
              label="Agent effort"
              value={formatDuration(totalEffort)}
              hint="parallel agents counted separately"
            />
            <Stat
              label="Leverage"
              value={leverage(totalFocus, totalWall)}
              hint="agent wall-clock per hour of focus"
              tone="focus"
            />
          </section>
          )}

          <section className="panel">
            <div className="panel-head">
              <h2>Timeline</h2>
              <div className="panel-head-right">
                <span className="panel-note">{byDay ? 'by day' : 'by hour'}</span>
                <div className="seg" role="group" aria-label="Show projects">
                  {FILTERS.map((f) => (
                    <button
                      key={f.id}
                      className={f.id === laneFilter ? 'active' : ''}
                      onClick={() => setLaneFilter(f.id)}
                    >
                      {f.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            {loading ? (
              <LanesSkeleton count={4} />
            ) : byDay && loadedRange ? (
              <DayMatrix days={days} from={loadedRange.from} to={loadedRange.to} filter={laneFilter} />
            ) : (
              <TimelineStrip
                key={loadedRange ? `${loadedRange.from}_${loadedRange.to}_${laneFilter}` : 'loading'}
                spans={spans}
                filter={laneFilter}
                days={days}
                onChanged={() => void load()}
              />
            )}
          </section>
        </div>
      )}

      {tab === 'timesheet' && (
        <div>
          <section className="panel">
            <div className="panel-head">
              <h2>Timesheet</h2>
              <span className="panel-note">by billing week — use the week nav below</span>
            </div>
            {hasBilling ? (
              <TimesheetPanel projects={projects} today={todayLocal()} />
            ) : (
              <p className="empty">
                No project has billing rules yet. Add a <code>billing</code> block under{' '}
                <code>projects["&lt;path&gt;"]</code> in <code>~/.traicker/config.json</code>, or set one under the
                Projects tab.
              </p>
            )}
          </section>
        </div>
      )}

      {tab === 'projects' && (
        <div>
          <section className="panel">
            <div className="panel-head">
              <h2>Projects</h2>
              <span className="panel-note">editable — writes through to config.json</span>
            </div>
            {/* Deliberately `allTotals`, not `totals`: selecting a project in
                the sidebar narrows what the other views are about, but this
                view edits the projects themselves — filtering it to one would
                hide the rest of the settings you came here to change. */}
            <ProjectsPanel
              totals={allTotals}
              loading={loading}
              onChanged={() => {
                void load();
                loadProjects();
              }}
            />
          </section>
        </div>
      )}

      {tab === 'models' && (
        <div>
          <section className="panel">
            <div className="panel-head">
              <h2>Models</h2>
              <span className="panel-note">internal estimate — never shown to a client</span>
            </div>
            {loading ? (
              <LanesSkeleton count={3} />
            ) : (
              <ModelsPanel models={models} unpriced={unpricedModels} />
            )}
          </section>
        </div>
      )}

      {tab === 'entries' && (
        <div>
          <section className="panel">
            <div className="panel-head">
              <h2>Time off the tools</h2>
              <span className="panel-note">
                meetings, calls, research — anything that emits no events. Logged to a fixed date below; the list
                shows the range above, for every project — pick the one to log against in the form.
              </span>
            </div>
            <EntryForm projects={projects} range={loadedRange} onChanged={() => void load()} />
          </section>
        </div>
      )}
      </main>
    </div>
  );
}

/**
 * Placeholders shaped like the content they stand in for.
 *
 * Shaped, rather than a centred "Loading…", because the point is to show that
 * the layout is intact and a specific thing is missing from it — a bare word
 * in an empty panel looks the same whether the request is in flight or the
 * page has given up. `aria-hidden` keeps them out of the accessibility tree;
 * the toolbar's live region is what announces the wait.
 */
function StatsSkeleton({ count }: { count: number }) {
  return (
    <section className="stats" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="stat skeleton">
          <span className="sk sk-label" />
          <span className="sk sk-value" />
        </div>
      ))}
    </section>
  );
}

function LanesSkeleton({ count }: { count: number }) {
  return (
    <div className="lanes-skeleton" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="sk-lane">
          <span className="sk sk-lane-name" />
          {/* Widths vary so the block reads as rows of data rather than as a
              loading bar someone forgot to animate. */}
          <span className="sk sk-lane-track" style={{ width: `${88 - i * 11}%` }} />
        </div>
      ))}
    </div>
  );
}

/**
 * Duration for the source list: `6h12` rather than `6h 12m`.
 *
 * The list is a column of names whose widths already vary; a compact,
 * fixed-shape figure keeps the right edge readable as a column instead of a
 * ragged one. Nothing else in the app uses this — every other surface has room
 * for `formatDuration`.
 */
function formatShort(ms: number): string {
  if (ms <= 0) return '—';
  const minutes = Math.round(ms / 60_000);
  const hours = Math.floor(minutes / 60);
  return hours > 0 ? `${hours}h${String(minutes % 60).padStart(2, '0')}` : `${minutes}m`;
}

/**
 * `tone` keeps a metric the same colour everywhere it appears — billable is
 * green in the stat row, the table and the timeline, so the eye can follow one
 * number across panels without re-reading the label.
 */
function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint: string;
  tone?: 'billable' | 'focus';
}) {
  return (
    <div className={`stat ${tone ? `tone-${tone}` : ''}`}>
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
      <span className="stat-hint">{hint}</span>
    </div>
  );
}

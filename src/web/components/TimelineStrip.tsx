import { useEffect, useMemo, useRef, useState } from 'react';

import {
  ApiError,
  api,
  formatCost,
  formatDuration,
  localTime,
  projectColor,
  type ExclusionConflict,
  type ProjectDay,
  type TimelineSpan,
} from '../api.js';
import { axisTicks } from '../axis.js';

export type BillableFilter = 'billable' | 'other' | 'all';

interface Props {
  spans: TimelineSpan[];
  filter: BillableFilter;
  /**
   * Per-project totals for the day(s) shown, used only for their `cost_usd` —
   * this view only ever renders when that's at most one calendar day (see
   * `byDay` in App.tsx), so a project's cost here is that one day's spend.
   */
  days: ProjectDay[];
  /** Called after an exclusion is saved or removed, so the page refetches. */
  onChanged: () => void;
}

const LABEL_WIDTH = 150;
const RIGHT_PAD = 16;
const CHART_WIDTH = 900;
const FOCUS_HEIGHT = 16;
const AGENT_HEIGHT = 7;
const AGENT_GAP = 2;
const PROJECT_GAP = 18;
const AXIS_HEIGHT = 26;
const PLOT_WIDTH = CHART_WIDTH - LABEL_WIDTH - RIGHT_PAD;

/** Below this a zoomed-in window stops meaning anything — spans this short can't be told apart at 900px anyway. */
const MIN_WINDOW_MS = 60_000;

interface View {
  start: number;
  end: number;
}

interface PackedSpan {
  span: TimelineSpan;
  lane: number;
}

/**
 * Greedy interval packing: each span goes in the first lane that is already
 * free at its start time.
 *
 * The lane count that falls out is the actual concurrency, which is the number
 * this whole tool exists to make visible. Drawing agent spans on one line would
 * flatten five parallel agents into something indistinguishable from one.
 */
function packLanes(spans: TimelineSpan[]): { packed: PackedSpan[]; laneCount: number } {
  const sorted = [...spans].sort((a, b) => Date.parse(a.start_utc) - Date.parse(b.start_utc));
  const laneEnds: number[] = [];
  const packed: PackedSpan[] = [];

  for (const span of sorted) {
    const start = Date.parse(span.start_utc);
    const end = Date.parse(span.end_utc);

    let lane = laneEnds.findIndex((laneEnd) => laneEnd <= start);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(end);
    } else {
      laneEnds[lane] = end;
    }
    packed.push({ span, lane });
  }

  return { packed, laneCount: Math.max(laneEnds.length, 1) };
}

/** How often the now-line moves. A minute of drift is invisible at 900px across a day's worth of hours. */
const NOW_TICK_MS = 30_000;

/**
 * `<input type="datetime-local">` wants local wall-clock time, with no
 * timezone of its own.
 *
 * Includes seconds on purpose: a real event timestamp almost never lands on
 * a whole minute, and truncating it here would silently narrow the window
 * actually submitted — leaving a sub-minute sliver of the block un-excluded
 * even when the fields are submitted untouched, with no way to select that
 * sliver's own boundary through a minute-only field to clear it.
 */
function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** The inverse: a bare `datetime-local` value has no timezone, so `Date` reads it as local — same convention `toLocalInput` wrote it in. */
function fromLocalInput(value: string): Date {
  return new Date(value);
}

export function TimelineStrip({ spans, filter, days, onChanged }: Props) {
  const [hovered, setHovered] = useState<TimelineSpan | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<{ x: number; view: View } | null>(null);
  // null means "follow the full domain" — sticks that way until the user
  // actually zooms or pans, so a live day keeps growing on its own until
  // they've expressed an interest in a fixed window.
  const [view, setView] = useState<View | null>(null);
  const [panning, setPanning] = useState(false);

  // The agent span picked to correct — only agent blocks are clickable, since
  // an exclusion only ever cuts the agent bucket (see excluded_spans and
  // `traicker exclude`). Independent of `hovered`, which is transient.
  const [selected, setSelected] = useState<TimelineSpan | null>(null);
  // Prefilled to the clicked block's own bounds, but editable — the block's
  // duration is usually not exactly how much was wrong (an outage might only
  // be the tail end of it), so the window sent to the server is whatever
  // these say, not necessarily the whole block.
  const [excludeStart, setExcludeStart] = useState('');
  const [excludeEnd, setExcludeEnd] = useState('');
  // What the fields were prefilled to, so submit can tell "untouched" from
  // "edited" per side. `datetime-local` only carries whole seconds — a real
  // event timestamp almost never lands on one, so parsing an untouched field
  // back would quietly shave off however many milliseconds got floored away.
  // For a block already trimmed down to a couple of seconds, that shaved
  // sliver is the whole remainder: it survives every "remove" click forever.
  // Only a field the user actually retyped goes through the lossy string;
  // an untouched one uses the span's own exact millisecond bounds.
  const [initialStart, setInitialStart] = useState('');
  const [initialEnd, setInitialEnd] = useState('');
  const [excludeNote, setExcludeNote] = useState('');
  const [excludeError, setExcludeError] = useState<string | null>(null);
  const [excludeConflicts, setExcludeConflicts] = useState<ExclusionConflict[] | null>(null);
  const [excluding, setExcluding] = useState(false);

  const openExclude = (span: TimelineSpan) => {
    const startStr = toLocalInput(span.start_utc);
    const endStr = toLocalInput(span.end_utc);
    setSelected(span);
    setExcludeStart(startStr);
    setExcludeEnd(endStr);
    setInitialStart(startStr);
    setInitialEnd(endStr);
    setExcludeNote('');
    setExcludeError(null);
    setExcludeConflicts(null);
  };

  const cancelExclude = () => {
    setSelected(null);
    setExcludeConflicts(null);
    setExcludeError(null);
  };

  const submitExclude = async (force: boolean) => {
    if (!selected) return;
    const startMs =
      excludeStart === initialStart ? Date.parse(selected.start_utc) : fromLocalInput(excludeStart).getTime();
    const endMs = excludeEnd === initialEnd ? Date.parse(selected.end_utc) : fromLocalInput(excludeEnd).getTime();
    if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs <= startMs) {
      setExcludeError('End must be after start.');
      return;
    }
    setExcluding(true);
    setExcludeError(null);
    try {
      await api.addExclusion({
        projectId: selected.project_id,
        startUtc: new Date(startMs).toISOString(),
        endUtc: new Date(endMs).toISOString(),
        note: excludeNote || undefined,
        force,
      });
      setSelected(null);
      setExcludeNote('');
      setExcludeConflicts(null);
      onChanged();
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409) {
        const body = cause.body as { conflicts?: ExclusionConflict[] };
        setExcludeConflicts(body.conflicts ?? []);
        setExcludeError('That window overlaps an existing exclusion.');
      } else {
        setExcludeError(cause instanceof Error ? cause.message : String(cause));
        setExcludeConflicts(null);
      }
    } finally {
      setExcluding(false);
    }
  };

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), NOW_TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const model = useMemo(() => {
    const visible = spans.filter((s) =>
      filter === 'all' ? true : filter === 'billable' ? s.billable === 1 : s.billable !== 1,
    );
    if (visible.length === 0) return null;

    const costByProject = new Map(days.map((d) => [d.project_id, d.cost_usd ?? null]));

    // The axis is built from what is shown, not from the whole range: filtering
    // to one client should zoom to that client's hours rather than leave the
    // strip mostly empty.
    const starts = visible.map((s) => Date.parse(s.start_utc));
    const ends = visible.map((s) => Date.parse(s.end_utc));
    // Snap the domain to whole hours so the gridlines land on round numbers.
    const domainStart = Math.floor(Math.min(...starts) / 3_600_000) * 3_600_000;
    const domainEnd = Math.ceil(Math.max(...ends) / 3_600_000) * 3_600_000;

    const byProject = new Map<
      number,
      {
        name: string;
        isBillable: boolean;
        color: string | null;
        focus: TimelineSpan[];
        agent: TimelineSpan[];
        billable: TimelineSpan[];
      }
    >();
    for (const s of visible) {
      let entry = byProject.get(s.project_id);
      if (!entry) {
        entry = {
          name: s.project_name,
          isBillable: s.billable === 1,
          color: s.color,
          focus: [],
          agent: [],
          billable: [],
        };
        byProject.set(s.project_id, entry);
      }
      // Occupancy is a derived envelope, not a third kind of work — it must not
      // be packed into the agent lanes or it would fake extra concurrency.
      if (s.bucket === 'focus') entry.focus.push(s);
      else if (s.bucket === 'occupancy') entry.billable.push(s);
      else entry.agent.push(s);
    }

    let y = 0;
    // Billable clients lead. Within each group, the busiest first — so the lane
    // that ends up on an invoice is never below one that does not.
    const rows = [...byProject.entries()]
      .sort((a, b) => {
        if (a[1].isBillable !== b[1].isBillable) return a[1].isBillable ? -1 : 1;
        return b[1].focus.length - a[1].focus.length;
      })
      .map(([projectId, entry]) => {
        const { packed, laneCount } = packLanes(entry.agent);
        const height = FOCUS_HEIGHT + 4 + laneCount * (AGENT_HEIGHT + AGENT_GAP);
        // The billable envelope, not focus or agent wall time alone — it is the
        // same total the invoice is built from, so the label under the name
        // answers "how much of this day" with the number that actually counts.
        const total = entry.billable.reduce((sum, s) => sum + s.duration_ms, 0);
        const row = {
          projectId,
          name: entry.name,
          isBillable: entry.isBillable,
          color: entry.color,
          focus: entry.focus,
          billable: entry.billable,
          packed,
          laneCount,
          total,
          cost: costByProject.get(projectId) ?? null,
          y,
          height,
        };
        y += height + PROJECT_GAP;
        return row;
      });

    return { rows, height: y + AXIS_HEIGHT, domainStart, domainEnd };
  }, [spans, filter, days]);

  // Clamped rather than reset, so a live day that's still accumulating spans
  // keeps extending the default full view instead of freezing it — and so a
  // window from before a filter narrowed the data never points outside it.
  const effectiveView = useMemo((): View | null => {
    if (!model) return null;
    if (!view) return { start: model.domainStart, end: model.domainEnd };
    const domainSpan = model.domainEnd - model.domainStart;
    const window = Math.min(Math.max(view.end - view.start, MIN_WINDOW_MS), domainSpan);
    const start = Math.min(Math.max(view.start, model.domainStart), model.domainEnd - window);
    return { start, end: start + window };
  }, [view, model]);

  const zoomed = view !== null;

  const x = (ms: number): number => {
    if (!effectiveView) return LABEL_WIDTH;
    const span = Math.max(effectiveView.end - effectiveView.start, 1);
    return LABEL_WIDTH + ((ms - effectiveView.start) / span) * PLOT_WIDTH;
  };

  const ticks = useMemo(
    () => (effectiveView ? axisTicks(effectiveView.start, effectiveView.end) : []),
    [effectiveView],
  );

  // Only meaningful when the visible window actually contains the present —
  // a range that's entirely in the past shouldn't grow a "now" marker at
  // whichever edge happens to be closest.
  const nowX = effectiveView && now >= effectiveView.start && now <= effectiveView.end ? x(now) : null;

  const clampToDomain = (next: View): View => {
    if (!model) return next;
    let { start, end } = next;
    if (start < model.domainStart) {
      end += model.domainStart - start;
      start = model.domainStart;
    }
    if (end > model.domainEnd) {
      start -= end - model.domainEnd;
      end = model.domainEnd;
    }
    return { start: Math.max(start, model.domainStart), end: Math.min(end, model.domainEnd) };
  };

  const handleWheel = (event: React.WheelEvent<SVGSVGElement>) => {
    if (!model || !effectiveView) return;
    event.preventDefault();
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;

    const viewBoxX = ((event.clientX - rect.left) / rect.width) * CHART_WIDTH;
    const frac = Math.min(1, Math.max(0, (viewBoxX - LABEL_WIDTH) / PLOT_WIDTH));
    const span = effectiveView.end - effectiveView.start;
    const anchor = effectiveView.start + frac * span;

    // Scroll up zooms in, scroll down zooms out — same convention as a map.
    const domainSpan = model.domainEnd - model.domainStart;
    const factor = Math.exp(event.deltaY * 0.001);
    const nextSpan = Math.min(domainSpan, Math.max(MIN_WINDOW_MS, span * factor));
    const nextStart = anchor - frac * nextSpan;
    setView(clampToDomain({ start: nextStart, end: nextStart + nextSpan }));
  };

  const handleMouseDown = (event: React.MouseEvent<SVGSVGElement>) => {
    if (!effectiveView || event.button !== 0) return;
    event.preventDefault();
    dragRef.current = { x: event.clientX, view: effectiveView };
    setPanning(true);
  };

  useEffect(() => {
    if (!panning) return;

    const handleMove = (event: MouseEvent) => {
      const drag = dragRef.current;
      const rect = svgRef.current?.getBoundingClientRect();
      if (!drag || !rect || rect.width === 0) return;

      const dxViewBox = ((event.clientX - drag.x) / rect.width) * CHART_WIDTH;
      const span = drag.view.end - drag.view.start;
      const msPerPx = span / PLOT_WIDTH;
      const shift = dxViewBox * msPerPx;
      setView(clampToDomain({ start: drag.view.start - shift, end: drag.view.end - shift }));
    };
    const handleUp = () => {
      dragRef.current = null;
      setPanning(false);
    };

    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panning]);

  const resetView = () => setView(null);

  // What the two fields actually mean, spelled out live: the fields hold the
  // window that gets *removed*, which reads the opposite way if all you see
  // is two times that started out equal to the block's own bounds — someone
  // narrowing them naturally expects to be describing the corrected span, not
  // the cut. This makes the direction unambiguous before they submit.
  let previewText: string | null = null;
  if (selected) {
    // Mirrors submitExclude's own untouched-field-uses-exact-bounds rule —
    // otherwise the preview can promise a remainder that submit then doesn't
    // actually leave behind (or the reverse), for the same reason a leftover
    // under a second used to survive its own removal.
    const cutStartMs =
      excludeStart === initialStart ? Date.parse(selected.start_utc) : fromLocalInput(excludeStart).getTime();
    const cutEndMs = excludeEnd === initialEnd ? Date.parse(selected.end_utc) : fromLocalInput(excludeEnd).getTime();
    if (!Number.isNaN(cutStartMs) && !Number.isNaN(cutEndMs) && cutEndMs > cutStartMs) {
      const blockStart = Date.parse(selected.start_utc);
      const blockEnd = Date.parse(selected.end_utc);
      const overlapMs = Math.max(0, Math.min(blockEnd, cutEndMs) - Math.max(blockStart, cutStartMs));
      const remainMs = Math.max(selected.duration_ms - overlapMs, 0);
      previewText =
        remainMs > 0
          ? `Removes ${formatDuration(overlapMs)} — leaves ${formatDuration(remainMs)} of the block untouched.`
          : `Removes the whole block (${formatDuration(overlapMs)}).`;
    }
  }

  if (!model) {
    return (
      <p className="empty">
        {filter === 'billable'
          ? 'No billable time in this range.'
          : filter === 'other'
            ? 'No non-billable time in this range.'
            : 'No spans recorded in this range.'}
      </p>
    );
  }

  return (
    <div className="timeline">
      {zoomed && (
        <button className="timeline-reset" onClick={resetView}>
          Reset zoom
        </button>
      )}
      <svg
        ref={svgRef}
        viewBox={`0 0 ${CHART_WIDTH} ${model.height}`}
        width="100%"
        role="img"
        aria-label="Activity timeline — scroll to zoom, drag to pan"
        className={panning ? 'panning' : ''}
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onDoubleClick={resetView}
      >
        <defs>
          <clipPath id="timeline-plot-clip">
            <rect x={LABEL_WIDTH} y={0} width={PLOT_WIDTH} height={model.height} />
          </clipPath>
        </defs>

        {/* Row labels live outside the clip — they're the one thing that must
            stay put in the left margin no matter how far the plot is panned. */}
        {model.rows.map((row) => (
          <g key={`label-${row.projectId}`} className={row.isBillable ? '' : 'lane-other'}>
            <text x={LABEL_WIDTH - 10} y={row.y + FOCUS_HEIGHT - 3} className="row-label" textAnchor="end">
              {row.name}
            </text>
            {row.total > 0 && (
              <text x={LABEL_WIDTH - 10} y={row.y + FOCUS_HEIGHT + 9} className="row-total" textAnchor="end">
                {formatDuration(row.total)}
              </text>
            )}
            {row.cost !== null && (
              <text x={LABEL_WIDTH - 10} y={row.y + FOCUS_HEIGHT + 20} className="row-cost" textAnchor="end">
                {formatCost(row.cost)}
              </text>
            )}
          </g>
        ))}

        <g clipPath="url(#timeline-plot-clip)">
          {ticks.map((tick) => (
            <g key={tick.at}>
              <line
                x1={x(tick.at)}
                x2={x(tick.at)}
                y1={0}
                y2={model.height - AXIS_HEIGHT}
                className={tick.major ? 'grid grid-day' : 'grid'}
              />
              <text
                x={x(tick.at)}
                y={model.height - 8}
                className={tick.major ? 'axis-label axis-label-day' : 'axis-label'}
                textAnchor={tick.major ? 'start' : 'middle'}
                dx={tick.major ? 4 : 0}
              >
                {tick.label}
              </text>
            </g>
          ))}

          {model.rows.map((row) => {
            const color = projectColor(row.projectId, row.color);
            return (
              <g key={row.projectId} className={row.isBillable ? 'lane lane-billable' : 'lane lane-other'}>
                {/* Billable envelope: drawn behind everything, so the extent of
                    what gets invoiced is visible against what produced it. */}
                {row.billable.map((s, i) => {
                  const x1 = x(Date.parse(s.start_utc));
                  const x2 = x(Date.parse(s.end_utc));
                  return (
                    <rect
                      key={`b${i}`}
                      x={x1}
                      y={row.y - 3}
                      width={Math.max(x2 - x1, 1.5)}
                      height={row.height + 3}
                      rx={3}
                      fill={color}
                      className="span billable-span"
                      onMouseEnter={() => setHovered(s)}
                      onMouseLeave={() => setHovered(null)}
                    />
                  );
                })}

                {/* Focus: solid and prominent. Never overlaps another project. */}
                {row.focus.map((s, i) => {
                  const x1 = x(Date.parse(s.start_utc));
                  const x2 = x(Date.parse(s.end_utc));
                  return (
                    <rect
                      key={`f${i}`}
                      x={x1}
                      y={row.y}
                      width={Math.max(x2 - x1, 1.5)}
                      height={FOCUS_HEIGHT}
                      rx={2}
                      fill={color}
                      className="span focus-span"
                      onMouseEnter={() => setHovered(s)}
                      onMouseLeave={() => setHovered(null)}
                    />
                  );
                })}

                {/* Agent: translucent, stacked. Height shows real concurrency.
                    Clickable — only agent blocks, since an exclusion only
                    ever corrects the agent bucket. */}
                {row.packed.map(({ span: s, lane }, i) => {
                  const x1 = x(Date.parse(s.start_utc));
                  const x2 = x(Date.parse(s.end_utc));
                  const visibleWidth = Math.max(x2 - x1, 1.5);
                  const laneY = row.y + FOCUS_HEIGHT + 4 + lane * (AGENT_HEIGHT + AGENT_GAP);
                  // A block already narrowed down to a minute or less (the
                  // leftover of a previous cut, say) can render as little as
                  // 1.5px wide — wide enough to see, not wide enough to hit
                  // with a mouse. The hit target is padded out independently
                  // of what's drawn, so the one sliver still needing a fix
                  // never becomes the one nobody can click.
                  const hitWidth = Math.max(visibleWidth, 8);
                  const hitX = x1 - (hitWidth - visibleWidth) / 2;
                  return (
                    <g key={`a${i}`}>
                      <rect
                        x={hitX}
                        y={laneY - 3}
                        width={hitWidth}
                        height={AGENT_HEIGHT + 6}
                        fill="transparent"
                        className="span-hit"
                        onMouseEnter={() => setHovered(s)}
                        onMouseLeave={() => setHovered(null)}
                        onClick={(event) => {
                          event.stopPropagation();
                          openExclude(s);
                        }}
                      />
                      <rect
                        x={x1}
                        y={laneY}
                        width={visibleWidth}
                        height={AGENT_HEIGHT}
                        rx={1.5}
                        fill={color}
                        // `:hover` can't reach this rect once pointer-events
                        // is off it, so the highlight is driven from the
                        // same `hovered` state the hit target already sets.
                        className={`span agent-span excludable ${s.source} ${hovered === s ? 'span-hovered' : ''}`}
                        pointerEvents="none"
                      />
                    </g>
                  );
                })}
              </g>
            );
          })}

          {nowX !== null && <line x1={nowX} x2={nowX} y1={0} y2={model.height - AXIS_HEIGHT} className="now-line" />}
        </g>
      </svg>

      <div className="timeline-legend">
        <span>
          <i className="key billable-key" /> billable block
        </span>
        <span>
          <i className="key focus-key" /> focus — sequential, never overlaps
        </span>
        <span>
          <i className="key agent-key" /> agent — one lane per concurrent run
        </span>
        <span className="legend-note">colour = project</span>
        <span className="legend-note">scroll to zoom · drag to pan</span>
      </div>

      {/* Click-to-correct takes over this slot instead of stacking a second
          panel below — the two are never useful at once. */}
      {selected ? (
        <div className="tooltip visible exclude-panel">
          <div className="exclude-head">
            <strong>Remove agent time</strong>
            <button type="button" className="exclude-close" onClick={cancelExclude} aria-label="Cancel">
              ×
            </button>
          </div>
          <span>
            {selected.project_name} · {selected.title ?? '(untitled)'} · block was{' '}
            {formatDuration(selected.duration_ms)}
          </span>
          <div className="exclude-range">
            <span className="exclude-range-label">Remove from</span>
            <input
              type="datetime-local"
              step="1"
              className="exclude-time"
              value={excludeStart}
              onChange={(event) => setExcludeStart(event.target.value)}
            />
            <span className="exclude-range-label">to</span>
            <input
              type="datetime-local"
              step="1"
              className="exclude-time"
              value={excludeEnd}
              onChange={(event) => setExcludeEnd(event.target.value)}
            />
          </div>
          {previewText && <span className="exclude-preview">{previewText}</span>}
          <input
            type="text"
            className="exclude-note"
            placeholder="Why? (e.g. Opus outage, agent stuck retrying)"
            value={excludeNote}
            onChange={(event) => setExcludeNote(event.target.value)}
          />
          <div className="exclude-actions">
            <button type="button" disabled={excluding} onClick={() => void submitExclude(false)}>
              {excluding ? 'Removing…' : 'Remove this time'}
            </button>
            <button type="button" className="exclude-cancel" onClick={cancelExclude}>
              Cancel
            </button>
          </div>
          {excludeError && <div className="error">{excludeError}</div>}
          {excludeConflicts && excludeConflicts.length > 0 && (
            <div className="ef-conflicts">
              {excludeConflicts.map((c) => (
                <div key={c.id}>
                  #{c.id} {c.start.slice(11, 16)}–{c.end.slice(11, 16)} UTC {c.note ? `· ${c.note}` : ''}
                </div>
              ))}
              <button type="button" className="ef-force" onClick={() => void submitExclude(true)}>
                Exclude anyway
              </button>
            </div>
          )}
        </div>
      ) : (
        /* Hover detail lives in component state, never in storage. */
        <div className={`tooltip ${hovered ? 'visible' : ''}`}>
          {!hovered && <span className="tooltip-hint">Hover a block for what it was, when, and how long.</span>}
          {hovered && (
            <>
              <strong>{hovered.title ?? '(untitled)'}</strong>
              <span>
                {hovered.project_name} · {hovered.bucket} · {hovered.source}
                {hovered.agent_type ? ` · ${hovered.agent_type}` : ''}
              </span>
              <span>
                {localTime(hovered.start_utc)} → {localTime(hovered.end_utc)} ({formatDuration(hovered.duration_ms)})
                {hovered.truncated_by ? ` · cut: ${hovered.truncated_by}` : ''}
                {hovered.bucket === 'agent' ? ' · click to exclude' : ''}
              </span>
            </>
          )}
        </div>
      )}
    </div>
  );
}

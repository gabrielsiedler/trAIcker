import { useMemo, useState } from 'react';

import { formatCost, formatDuration, num, projectColor, shortDate, type ProjectDay } from '../api.js';
import type { BillableFilter } from './TimelineStrip.js';

interface Props {
  days: ProjectDay[];
  /** Inclusive range to lay out, so days with no work still get a column. */
  from: string;
  to: string;
  filter: BillableFilter;
}

/** Beyond this the columns get too narrow to carry a number. */
const MAX_COLUMNS = 62;

/**
 * A project by day, when the range is too wide to draw honestly as a gantt.
 *
 * The detailed strip plots real start and end times, which is the right picture
 * of a day. Over a week it stops being one: four hundred spans across a
 * 750-pixel axis puts a two-minute agent run at under a pixel, so the strip
 * becomes a smear that cannot be read or trusted.
 *
 * So past a couple of days the unit changes from the hour to the day. Time of
 * day is gone — that is the trade — and in exchange every bar is a real
 * quantity you can compare across a fortnight.
 *
 * The numbers come from the per-day summary the page already fetched, not from
 * re-aggregating spans in the browser: one source for a billable figure.
 */
export function DayMatrix({ days, from, to, filter }: Props) {
  const [hovered, setHovered] = useState<{ project: string; day: string; row: ProjectDay } | null>(null);

  const model = useMemo(() => {
    const visible = days.filter((d) =>
      filter === 'all' ? true : filter === 'billable' ? d.billable === 1 : d.billable !== 1,
    );
    if (visible.length === 0) return null;

    const columns = daysBetween(from, to, visible);

    const byProject = new Map<number, { name: string; isBillable: boolean; color: string | null }>();
    for (const d of visible) {
      if (!byProject.has(d.project_id)) {
        byProject.set(d.project_id, {
          name: d.project_name,
          isBillable: d.billable === 1,
          color: d.color ?? null,
        });
      }
    }

    const cells = new Map<string, ProjectDay>();
    for (const d of visible) cells.set(`${d.project_id}|${d.local_day}`, d);

    // One scale across every cell, so a tall bar means the same thing in every
    // row. Scaling per row would make a quiet project look like a busy one.
    const peak = Math.max(...visible.map((d) => num(d.occupancy_ms)), 1);

    const rows = [...byProject.entries()]
      .map(([projectId, meta]) => {
        const total = visible
          .filter((d) => d.project_id === projectId)
          .reduce((sum, d) => sum + num(d.occupancy_ms), 0);
        return { projectId, ...meta, total };
      })
      // Billable clients lead, then the busiest — the same order as the strip.
      .sort((a, b) => {
        if (a.isBillable !== b.isBillable) return a.isBillable ? -1 : 1;
        return b.total - a.total;
      });

    return { columns, rows, cells, peak };
  }, [days, from, to, filter]);

  if (!model) {
    return (
      <p className="empty">
        {filter === 'billable'
          ? 'No billable time in this range.'
          : filter === 'other'
            ? 'No non-billable time in this range.'
            : 'No activity in this range.'}
      </p>
    );
  }

  const { columns, rows, cells, peak } = model;
  const compact = columns.length > 14;

  return (
    <div className="matrix">
      <div className="matrix-scroll">
        <div
          className="matrix-grid"
          style={{ gridTemplateColumns: `150px repeat(${columns.length}, minmax(${compact ? 26 : 48}px, 1fr))` }}
        >
          <div className="matrix-corner" />
          {columns.map((day) => (
            <div key={day} className={`matrix-colhead ${isWeekend(day) ? 'weekend' : ''}`}>
              {compact ? compactLabel(day) : shortDate(day)}
            </div>
          ))}

          {rows.map((row) => (
            <Row
              key={row.projectId}
              row={row}
              columns={columns}
              cells={cells}
              peak={peak}
              compact={compact}
              onHover={setHovered}
            />
          ))}
        </div>
      </div>

      <div className={`tooltip ${hovered ? 'visible' : ''}`}>
        {hovered ? (
          <>
            <strong>
              {hovered.project} · {shortDate(hovered.day)}
            </strong>
            <span>
              billable {formatDuration(hovered.row.occupancy_ms)} · focus {formatDuration(hovered.row.focus_ms)} · agent{' '}
              {formatDuration(hovered.row.agent_wall_ms)}
            </span>
            <span>
              {hovered.row.prompt_count} prompts · {hovered.row.subagent_count} subagent runs
              {hovered.row.cost_usd != null ? ` · ${formatCost(hovered.row.cost_usd)} est. LLM cost` : ''}
            </span>
          </>
        ) : (
          <span className="tooltip-hint">
            Bar height is billable time, on one scale across every row. Pick a single day for the hour-by-hour view.
          </span>
        )}
      </div>
    </div>
  );
}

function Row({
  row,
  columns,
  cells,
  peak,
  compact,
  onHover,
}: {
  row: { projectId: number; name: string; isBillable: boolean; color: string | null; total: number };
  columns: string[];
  cells: Map<string, ProjectDay>;
  peak: number;
  compact: boolean;
  onHover: (v: { project: string; day: string; row: ProjectDay } | null) => void;
}) {
  const color = projectColor(row.projectId, row.color);

  return (
    <>
      <div className={`matrix-label ${row.isBillable ? '' : 'other'}`}>
        <span className="swatch" style={{ background: color }} />
        <span className="matrix-name">{row.name}</span>
        <span className="matrix-total">{formatDuration(row.total)}</span>
      </div>

      {columns.map((day) => {
        const cell = cells.get(`${row.projectId}|${day}`);
        const ms = num(cell?.occupancy_ms);
        // A tracked day with a couple of minutes on it still gets a visible
        // sliver: "almost nothing" and "nothing" are different answers.
        const height = ms > 0 ? Math.max(8, Math.round((ms / peak) * 100)) : 0;

        return (
          <div
            key={day}
            className={`matrix-cell ${row.isBillable ? '' : 'other'} ${isWeekend(day) ? 'weekend' : ''}`}
            onMouseEnter={() => cell && onHover({ project: row.name, day, row: cell })}
            onMouseLeave={() => onHover(null)}
          >
            {ms > 0 ? (
              <>
                <span className="matrix-bar" style={{ height: `${height}%`, background: color }} />
                {!compact && <span className="matrix-value">{formatDuration(ms)}</span>}
              </>
            ) : (
              <span className="matrix-empty" aria-label="no time recorded" />
            )}
          </div>
        );
      })}
    </>
  );
}

/**
 * Every day in the range, so a gap reads as a gap.
 *
 * Falls back to only the days that carry data when the range is unbounded —
 * "all time" starts at year zero, and laying that out by day would try to
 * render three quarters of a million columns.
 */
function daysBetween(from: string, to: string, rows: readonly ProjectDay[]): string[] {
  const present = [...new Set(rows.map((r) => r.local_day))].sort();
  const start = Date.parse(`${from}T00:00:00.000Z`);
  const end = Date.parse(`${to}T00:00:00.000Z`);

  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return present;
  const span = Math.round((end - start) / 86_400_000) + 1;
  if (span > MAX_COLUMNS) return present;

  const out: string[] = [];
  for (let i = 0; i < span; i++) {
    out.push(new Date(start + i * 86_400_000).toISOString().slice(0, 10));
  }
  return out;
}

/**
 * Day of the month alone, with the month named on its first day.
 *
 * A 26-pixel column cannot hold "Mon, 22 Jul", and letting it try pushed every
 * header into its neighbour and forced the whole grid to scroll sideways.
 */
function compactLabel(day: string): string {
  const date = new Date(`${day}T12:00:00.000Z`);
  const dom = date.getUTCDate();
  if (dom !== 1) return String(dom);
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

function isWeekend(day: string): boolean {
  const weekday = new Date(`${day}T12:00:00.000Z`).getUTCDay();
  return weekday === 0 || weekday === 6;
}

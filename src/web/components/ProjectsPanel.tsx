import { Fragment, useCallback, useEffect, useState } from 'react';

import {
  api,
  formatCost,
  formatDuration,
  leverage,
  num,
  projectColor,
  WEEK_START_DAYS,
  type Billing,
  type Commitment,
  type ProjectSettings,
  type ProjectTotal,
} from '../api.js';

/** Capitalised for the select — `WEEK_START_DAYS` itself stays lowercase to match the config file. */
function weekdayLabel(day: string): string {
  return day[0]!.toUpperCase() + day.slice(1);
}

interface Props {
  totals: ProjectTotal[];
  loading: boolean;
  onChanged: () => void;
}

/**
 * One table for a project: what it's called, what colour it's drawn in, how
 * it bills, and how much time landed on it in the selected range. Splitting
 * this into a read-only table plus a separate settings form meant the two
 * fell out of sync — a project's numbers and its configuration are the same
 * fact seen two ways, so a row now carries both. The columns stay aligned so
 * projects are still comparable at a glance; editing opens inline underneath
 * the row it belongs to rather than in a second list.
 *
 * Configuration is written straight back to `~/.traicker/config.json`. The
 * file stays the source of truth so hand edits keep working; the server
 * carries unknown keys through untouched and takes a backup on every save.
 */

/**
 * Presets that stay distinguishable from one another on the dark ground, and
 * for the two most common kinds of colour blindness — a palette whose only
 * separation is red against green would defeat the point of choosing.
 */
const PRESETS = ['#3fb950', '#58a6ff', '#d29922', '#f85149', '#a371f7', '#2dd4bf', '#f778ba', '#8b949e'];

/** The derived colour, as hex, so `<input type="color">` has a value to show. */
function fallbackHex(projectId: number): string {
  const hues = [199, 152, 43, 340, 265, 15, 180, 95];
  const h = hues[projectId % hues.length]! / 360;
  const [s, l] = [0.7, 0.55];
  const k = (n: number) => (n + h * 12) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const hex = (n: number) =>
    Math.round(f(n) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${hex(0)}${hex(8)}${hex(4)}`;
}

interface Sums {
  occupancy: number;
  focus: number;
  wall: number;
  effort: number;
  prompts: number;
  subagents: number;
  idle: number;
  /** null when nothing in the group has an applicable price yet. */
  cost: number | null;
}

function totalsOf(rows: readonly ProjectTotal[]): Sums {
  const priced = rows.filter((t) => t.cost_usd != null);
  return {
    occupancy: rows.reduce((s, t) => s + num(t.occupancy_ms), 0),
    focus: rows.reduce((s, t) => s + num(t.focus_ms), 0),
    wall: rows.reduce((s, t) => s + num(t.agent_wall_ms), 0),
    effort: rows.reduce((s, t) => s + num(t.agent_effort_ms), 0),
    prompts: rows.reduce((s, t) => s + num(t.prompt_count), 0),
    subagents: rows.reduce((s, t) => s + num(t.subagent_count), 0),
    idle: rows.reduce((s, t) => s + num(t.idle_dropped_ms), 0),
    cost: priced.length === 0 ? null : priced.reduce((s, t) => s + (t.cost_usd ?? 0), 0),
  };
}

export function ProjectsPanel({ totals, loading, onChanged }: Props) {
  const [projects, setProjects] = useState<ProjectSettings[]>([]);
  const [configFile, setConfigFile] = useState('');
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState<ProjectSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await api.projectSettings();
      setProjects(response.projects);
      setConfigFile(response.configPath);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const startEdit = (project: ProjectSettings) => {
    setEditing(editing === project.id ? null : project.id);
    setDraft({ ...project });
    setError(null);
  };

  const save = async () => {
    if (!draft) return;
    try {
      await api.saveProject(draft.id, {
        name: draft.name,
        client: draft.client,
        billable: draft.billable === 1,
        color: draft.color,
        commitment: draft.commitment,
        billing: draft.billing,
      });
      setEditing(null);
      setDraft(null);
      setSaved(draft.id);
      window.setTimeout(() => setSaved((s) => (s === draft.id ? null : s)), 1500);
      await load();
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const patch = (change: Partial<ProjectSettings>) => setDraft((d) => (d ? { ...d, ...change } : d));

  const patchCommitment = (change: Partial<Commitment> | null) =>
    setDraft((d) =>
      d
        ? {
            ...d,
            commitment:
              change === null
                ? null
                : {
                    weeklyHours: 10,
                    kind: 'cap',
                    weekStartsOn: d.billing?.weekStartsOn ?? 'monday',
                    ...d.commitment,
                    ...change,
                  },
          }
        : d,
    );

  const patchBilling = (change: Partial<Billing> | null) =>
    setDraft((d) =>
      d
        ? {
            ...d,
            billing:
              change === null
                ? null
                : {
                    basis: 'occupancy',
                    roundToMinutes: 15,
                    weekStartsOn: d.commitment?.weekStartsOn ?? 'monday',
                    allowExcerpts: false,
                    ...d.billing,
                    ...change,
                  },
          }
        : d,
    );

  /**
   * A client has one real week, not two. `commitment` and `billing` carry
   * their own `weekStartsOn` because the cap and the timesheet can exist
   * independently — but when both blocks are present on the same project,
   * letting the two selects drift apart is how a project ends up with a
   * cap that resets Thursday while its timesheet still groups by Monday.
   * Setting either one here keeps both in sync.
   */
  const patchWeekStartsOn = (day: Commitment['weekStartsOn']) =>
    setDraft((d) =>
      d
        ? {
            ...d,
            commitment: d.commitment ? { ...d.commitment, weekStartsOn: day } : d.commitment,
            billing: d.billing ? { ...d.billing, weekStartsOn: day } : d.billing,
          }
        : d,
    );

  if (projects.length === 0) {
    return <p className="empty">No projects tracked yet.</p>;
  }

  const totalsById = new Map(totals.map((t) => [t.project_id, t]));
  const maxBillable = Math.max(...totals.map((t) => num(t.occupancy_ms)), 1);
  const excluded = totals.filter((t) => !t.billable);
  const billableOnly = totals.filter((t) => t.billable);
  const zero: ProjectTotal = {
    project_id: -1,
    project_name: '',
    client: null,
    billable: 1,
    focus_ms: 0,
    agent_wall_ms: 0,
    agent_effort_ms: 0,
    occupancy_ms: 0,
    idle_dropped_ms: 0,
    prompt_count: 0,
    subagent_count: 0,
    active_days: 0,
    cost_usd: null,
  };

  return (
    <div className="projects-panel">
      {error && <div className="error">{error}</div>}

      <div className="table-scroll">
        <table className="data pp-table">
          <thead>
            <tr>
              <th>Project</th>
              <th className="num" title="Wall-clock the project was worked on, by you or an agent you directed. Overlaps across projects.">
                Billable
              </th>
              <th className="num" title="Your attention only. Mutually exclusive across projects.">
                Focus
              </th>
              <th className="num">Agent</th>
              <th className="num">Effort</th>
              <th className="num" title="Agent wall-clock per hour of focus">
                Leverage
              </th>
              <th className="num">Prompts</th>
              <th className="num">Subagents</th>
              <th className="num" title="Discarded by the idle timeout">
                Idle
              </th>
              <th className="num" title="Estimated LLM spend — an internal figure, priced from modelPricing in config.json">
                Cost
              </th>
              <th className="pp-col-edit" aria-label="Edit" />
            </tr>
          </thead>
          <tbody>
            {projects.map((project) => {
              const isEditing = editing === project.id;
              const shown = isEditing && draft ? draft : project;
              const total = totalsById.get(project.id) ?? zero;

              return (
                <Fragment key={project.id}>
                  <tr className={isEditing ? 'pp-tr-editing' : ''}>
                    <td>
                      <span className="swatch" style={{ background: projectColor(project.id, shown.color) }} />
                      <span className="project-name">{shown.name}</span>
                      {shown.client && <span className="client">{shown.client}</span>}
                      {shown.billable === 0 && <span className="pp-tag">not billable</span>}
                      {shown.commitment && (
                        <span className="pp-tag">
                          {shown.commitment.weeklyHours}h/wk {shown.commitment.kind}
                        </span>
                      )}
                      {shown.billing && <span className="pp-tag billing">timesheet</span>}
                      {!project.configured && <span className="pp-tag muted-tag">defaults</span>}
                      {saved === project.id && <span className="pp-saved">saved</span>}
                    </td>
                    <td
                      className={`num ${project.billable ? 'billable' : 'muted'}`}
                      title={project.billable ? undefined : 'Not billable — excluded from the total'}
                    >
                      {loading ? (
                        '…'
                      ) : (
                        <div className="bar-cell">
                          <span>{formatDuration(total.occupancy_ms)}</span>
                          <span
                            className={`bar ${project.billable ? '' : 'bar-muted'}`}
                            style={{ width: `${(num(total.occupancy_ms) / maxBillable) * 100}%` }}
                          />
                        </div>
                      )}
                    </td>
                    <td className="num focus">{loading ? '…' : formatDuration(total.focus_ms)}</td>
                    <td className="num agent">{loading ? '…' : formatDuration(total.agent_wall_ms)}</td>
                    <td className="num muted">{loading ? '…' : formatDuration(total.agent_effort_ms)}</td>
                    <td className="num lev">{loading ? '…' : leverage(total.focus_ms, total.agent_wall_ms)}</td>
                    <td className="num muted">{loading ? '…' : total.prompt_count}</td>
                    <td className="num muted">{loading ? '…' : total.subagent_count}</td>
                    <td className="num muted">{loading ? '…' : formatDuration(total.idle_dropped_ms)}</td>
                    <td className="num muted">{loading ? '…' : formatCost(total.cost_usd)}</td>
                    <td className="pp-col-edit">
                      <button onClick={() => startEdit(project)}>{isEditing ? 'close' : 'edit'}</button>
                    </td>
                  </tr>

                  {isEditing && draft && (
                    <tr className="pp-tr-edit-row">
                      <td colSpan={11}>
                        <div className="pp-edit">
                          <label>
                            Name
                            <input value={draft.name} onChange={(e) => patch({ name: e.target.value })} />
                          </label>
                          <label>
                            Client
                            <input
                              value={draft.client ?? ''}
                              placeholder="none"
                              onChange={(e) => patch({ client: e.target.value || null })}
                            />
                          </label>
                          <label className="pp-check">
                            <input
                              type="checkbox"
                              checked={draft.billable === 1}
                              onChange={(e) => patch({ billable: e.target.checked ? 1 : 0 })}
                            />
                            Billable
                          </label>

                          {/* The hue is how a project is found in the timeline without
                              reading its label, and the derived one shifts when another
                              project is added — so it is worth pinning. */}
                          <div className="pp-colour">
                            <span className="pp-colour-label">Colour</span>
                            <input
                              type="color"
                              aria-label="Project colour"
                              value={draft.color ?? fallbackHex(draft.id)}
                              onChange={(e) => patch({ color: e.target.value })}
                            />
                            <div className="pp-swatches">
                              {PRESETS.map((hex) => (
                                <button
                                  key={hex}
                                  type="button"
                                  className={draft.color === hex ? 'pp-preset active' : 'pp-preset'}
                                  style={{ background: hex }}
                                  aria-label={`Use ${hex}`}
                                  onClick={() => patch({ color: hex })}
                                />
                              ))}
                            </div>
                            {draft.color !== null && (
                              <button type="button" className="pp-reset" onClick={() => patch({ color: null })}>
                                reset
                              </button>
                            )}
                          </div>

                          <fieldset>
                            <legend>
                              <label className="pp-check">
                                <input
                                  type="checkbox"
                                  checked={draft.commitment !== null}
                                  onChange={(e) => patchCommitment(e.target.checked ? {} : null)}
                                />
                                Weekly arrangement
                              </label>
                            </legend>
                            {draft.commitment && (
                              <div className="pp-fields">
                                <label>
                                  Hours
                                  <input
                                    type="number"
                                    min={1}
                                    value={draft.commitment.weeklyHours}
                                    onChange={(e) => patchCommitment({ weeklyHours: Number(e.target.value) })}
                                  />
                                </label>
                                <label>
                                  Kind
                                  <select
                                    value={draft.commitment.kind}
                                    onChange={(e) => patchCommitment({ kind: e.target.value as Commitment['kind'] })}
                                  >
                                    <option value="cap">cap — a ceiling, flagged from above</option>
                                    <option value="target">target — a commitment, judged at week end</option>
                                  </select>
                                </label>
                                <label>
                                  Week starts on
                                  <select
                                    value={draft.commitment.weekStartsOn}
                                    onChange={(e) => patchWeekStartsOn(e.target.value as Commitment['weekStartsOn'])}
                                  >
                                    {WEEK_START_DAYS.map((d) => (
                                      <option key={d} value={d}>
                                        {weekdayLabel(d)}
                                      </option>
                                    ))}
                                  </select>
                                </label>
                              </div>
                            )}
                          </fieldset>

                          <fieldset>
                            <legend>
                              <label className="pp-check">
                                <input
                                  type="checkbox"
                                  checked={draft.billing !== null}
                                  onChange={(e) => patchBilling(e.target.checked ? {} : null)}
                                />
                                Produces a timesheet
                              </label>
                            </legend>
                            {draft.billing && (
                              <div className="pp-fields">
                                <label>
                                  Basis
                                  <select
                                    value={draft.billing.basis}
                                    onChange={(e) => patchBilling({ basis: e.target.value as Billing['basis'] })}
                                  >
                                    <option value="occupancy">occupancy — worked on by you or an agent</option>
                                    <option value="focus">focus — your attention only</option>
                                  </select>
                                </label>
                                <label>
                                  Round to
                                  <select
                                    value={draft.billing.roundToMinutes}
                                    onChange={(e) => patchBilling({ roundToMinutes: Number(e.target.value) })}
                                  >
                                    {[1, 5, 6, 10, 15, 30, 60].map((m) => (
                                      <option key={m} value={m}>
                                        {m} min
                                      </option>
                                    ))}
                                  </select>
                                </label>
                                <label>
                                  Week starts on
                                  <select
                                    value={draft.billing.weekStartsOn}
                                    onChange={(e) => patchWeekStartsOn(e.target.value as Billing['weekStartsOn'])}
                                  >
                                    {WEEK_START_DAYS.map((d) => (
                                      <option key={d} value={d}>
                                        {weekdayLabel(d)}
                                      </option>
                                    ))}
                                  </select>
                                </label>
                                <label className="pp-check">
                                  <input
                                    type="checkbox"
                                    checked={draft.billing.allowExcerpts}
                                    onChange={(e) => patchBilling({ allowExcerpts: e.target.checked })}
                                  />
                                  Allow raw prompt text in descriptions
                                </label>
                              </div>
                            )}
                          </fieldset>

                          <div className="pp-actions">
                            <button className="pp-save" onClick={() => void save()}>
                              Save to config.json
                            </button>
                            <button
                              onClick={() => {
                                setEditing(null);
                                setDraft(null);
                              }}
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
          {!loading && totals.length > 0 && (
            <tfoot>
              <TotalRow label="All projects" sums={totalsOf(totals)} />
              {excluded.length > 0 && (
                <TotalRow label="Billable only" emphasis sums={totalsOf(billableOnly)} />
              )}
            </tfoot>
          )}
        </table>
      </div>

      <p className="pp-footer">
        Written to <code>{configFile}</code>. A timestamped backup is taken on every save, and keys you added by
        hand are preserved.
      </p>
    </div>
  );
}

function TotalRow({
  label,
  hint,
  emphasis,
  sums,
}: {
  label: string;
  hint?: string;
  emphasis?: boolean;
  sums: Sums;
}) {
  return (
    <tr className={emphasis ? 'total-billable' : 'total-all'}>
      <td>
        {label}
        {hint && (
          <span className="total-note" title={hint}>
            {hint}
          </span>
        )}
      </td>
      <td className={`num ${emphasis ? 'billable' : 'muted'}`}>{formatDuration(sums.occupancy)}</td>
      <td className="num focus">{formatDuration(sums.focus)}</td>
      <td className="num agent">{formatDuration(sums.wall)}</td>
      <td className="num muted">{formatDuration(sums.effort)}</td>
      <td className="num lev">{leverage(sums.focus, sums.wall)}</td>
      <td className="num muted">{sums.prompts}</td>
      <td className="num muted">{sums.subagents}</td>
      <td className="num muted">{formatDuration(sums.idle)}</td>
      <td className="num muted">{formatCost(sums.cost)}</td>
      <td />
    </tr>
  );
}

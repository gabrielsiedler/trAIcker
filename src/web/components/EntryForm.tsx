import { useCallback, useEffect, useState } from 'react';

import {
  ApiError,
  MANUAL_KINDS,
  api,
  formatDuration,
  projectColor,
  shortDate,
  todayLocal,
  type BillableProject,
  type DateRange,
  type ManualEntry,
  type ManualKind,
} from '../api.js';

interface Props {
  projects: BillableProject[];
  /** The header's range — scopes the list below. The log form's date field, below, stays fixed regardless. */
  range: DateRange | null;
  onChanged: () => void;
}

interface Conflict {
  id: number;
  project: string;
  start: string;
  end: string;
  note: string | null;
}

/**
 * Logs work that emitted no events — meetings, research, a call.
 *
 * Times are sent as typed and parsed on the server with the same code the CLI
 * uses, so the two surfaces cannot disagree about what `2pm` or `1h30m` means.
 */
export function EntryForm({ projects, range, onChanged }: Props) {
  const [projectId, setProjectId] = useState<number | null>(null);
  const [day, setDay] = useState(todayLocal());
  const [from, setFrom] = useState('');
  const [duration, setDuration] = useState('30m');
  const [kind, setKind] = useState<ManualKind>('meeting');
  const [note, setNote] = useState('');

  const [entries, setEntries] = useState<ManualEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<Conflict[] | null>(null);
  const [saving, setSaving] = useState(false);

  // Billable projects are what this form is usually for, so they lead the
  // list; non-billable ones stay reachable below a separator rather than
  // disappearing, since off-the-tools time still happens on internal work.
  const billableProjects = projects.filter((p) => p.billable === 1);
  const otherProjects = projects.filter((p) => p.billable !== 1);

  useEffect(() => {
    if (projectId === null && projects.length > 0) {
      setProjectId((billableProjects[0] ?? projects[0])!.id);
    }
  }, [projects, projectId, billableProjects]);

  const loadEntries = useCallback(async () => {
    if (!range) return;
    try {
      const response = await api.entries(range.from, range.to);
      setEntries(response.entries);
    } catch {
      setEntries([]);
    }
  }, [range]);

  useEffect(() => {
    void loadEntries();
  }, [loadEntries]);

  const submit = async (force: boolean) => {
    if (projectId === null) return;
    setSaving(true);
    setError(null);

    try {
      await api.addEntry({ projectId, day, from, duration, kind, note: note || undefined, force });
      setFrom('');
      setNote('');
      setConflicts(null);
      await loadEntries();
      onChanged();
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409) {
        const body = cause.body as { conflicts?: Conflict[] };
        setConflicts(body.conflicts ?? []);
        setError('That window overlaps existing manual time.');
      } else {
        setError(cause instanceof Error ? cause.message : String(cause));
        setConflicts(null);
      }
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: number) => {
    try {
      await api.deleteEntry(id);
      await loadEntries();
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const localTimes = (entry: ManualEntry) => {
    const shift = (iso: string) => new Date(Date.parse(iso) + entry.tz_offset_min * 60_000).toISOString();
    return `${shift(entry.start_utc).slice(11, 16)}–${shift(entry.end_utc).slice(11, 16)}`;
  };

  // Scoped to whatever project the form above is set to log against — seeing
  // every other project's entries here would just be noise while filling
  // this one in.
  const visibleEntries = projectId === null ? entries : entries.filter((e) => e.project_id === projectId);

  return (
    <div className="entry-form">
      <form
        className="ef-row"
        onSubmit={(event) => {
          event.preventDefault();
          void submit(false);
        }}
      >
        <select value={projectId ?? ''} onChange={(e) => setProjectId(Number(e.target.value))}>
          {billableProjects.length > 0 && (
            <optgroup label="Billable">
              {billableProjects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </optgroup>
          )}
          {otherProjects.length > 0 && (
            <optgroup label="Non-billable">
              {otherProjects.map((p) => (
                <option key={p.id} value={p.id} className="ef-option-muted">
                  {p.name}
                </option>
              ))}
            </optgroup>
          )}
        </select>

        <input type="date" value={day} onChange={(e) => setDay(e.target.value)} />

        <input
          type="text"
          className="ef-time"
          placeholder="14:00"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          required
        />

        <input
          type="text"
          className="ef-time"
          placeholder="30m"
          value={duration}
          onChange={(e) => setDuration(e.target.value)}
          required
        />

        <select value={kind} onChange={(e) => setKind(e.target.value as ManualKind)}>
          {MANUAL_KINDS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>

        <input
          type="text"
          className="ef-note"
          placeholder="What was it? (shown on the timesheet)"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />

        <button type="submit" disabled={saving || projectId === null}>
          {saving ? 'Saving…' : 'Log it'}
        </button>
      </form>

      <p className="ef-hint">
        Times accept 14:00, 1400 or 2pm. Duration accepts 30m, 1h, 1h30m. An entry ends focus on every project for
        that window and removes agent time on its own — so the same window is never billed twice.
      </p>

      {error && <div className="error">{error}</div>}

      {conflicts && conflicts.length > 0 && (
        <div className="ef-conflicts">
          {conflicts.map((c) => (
            <div key={c.id}>
              #{c.id} {c.project} {c.start.slice(11, 16)}–{c.end.slice(11, 16)} UTC {c.note ? `· ${c.note}` : ''}
            </div>
          ))}
          <button className="ef-force" onClick={() => void submit(true)}>
            Log it anyway
          </button>
        </div>
      )}

      {visibleEntries.length > 0 && (
        <table className="data ef-list">
          <tbody>
            {visibleEntries.map((e) => (
              <tr key={e.id}>
                <td className="ef-when">
                  {shortDate(e.start_utc.slice(0, 10))} {localTimes(e)}
                </td>
                <td>
                  <span className="swatch" style={{ background: projectColor(e.project_id) }} />
                  {e.project_name}
                </td>
                <td className="muted">{e.kind}</td>
                <td>{e.note ?? '—'}</td>
                <td className="num billable">
                  {formatDuration(Date.parse(e.end_utc) - Date.parse(e.start_utc))}
                </td>
                <td className="ts-actions">
                  <button onClick={() => void remove(e.id)}>remove</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

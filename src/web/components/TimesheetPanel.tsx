import { useCallback, useEffect, useRef, useState } from 'react';

import {
  api,
  formatHours,
  loadHoursFormat,
  saveHoursFormat,
  shiftDays,
  shortDate,
  weekStartOf,
  type BillableProject,
  type DateRange,
  type HoursFormat,
  type TimesheetResponse,
  type TimesheetWeek,
  type WeekStart,
} from '../api.js';

interface Props {
  projects: BillableProject[];
  today: string;
}

/** Roughly two lines at the description column's usual width — past this, clamp and offer to expand. */
const LONG_DESCRIPTION_CHARS = 140;

/**
 * The panel you actually fill a client's form from.
 *
 * It lives in the browser rather than only in the CLI because the form is
 * already open in another tab — copying a line from a terminal into a web form
 * is the kind of friction that makes a tracker stop getting used.
 */
export function TimesheetPanel({ projects, today }: Props) {
  const billable = projects.filter((p) => p.hasBilling);

  const [selected, setSelected] = useState(() => billable[0]?.name ?? '');
  const [weekOffset, setWeekOffset] = useState(0);
  /**
   * The project's actual week boundary, learned from the server's response.
   * Not every client bills Monday-to-Sunday, so this starts at the safe
   * default and is corrected the moment the first response for a project
   * comes back — see `weekStartsOn` on `resolved.billing` in the API.
   */
  const [weekStartsOn, setWeekStartsOn] = useState<WeekStart>('monday');
  const [data, setData] = useState<TimesheetResponse | null>(null);
  /**
   * This panel fetches on its own whenever the project or week changes, and
   * that request is as slow as the dashboard's. Without this, switching weeks
   * left the previous week's rows on screen with nothing to say they were
   * about to be replaced.
   */
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  /** Day currently being rewritten or reverted. One at a time — each rewrite costs money. */
  const [busyDay, setBusyDay] = useState<string | null>(null);
  /** Subset of `busyDay` that's specifically mid-rewrite, so revert (near-instant) doesn't borrow rewrite's "up to a minute" message. */
  const [generatingDay, setGeneratingDay] = useState<string | null>(null);
  /** Day whose redo/undo menu is open. One at a time; closed on outside click, Escape, or picking an item. */
  const [menuDay, setMenuDay] = useState<string | null>(null);
  /** Days whose description is expanded past its default 2-line clamp. */
  const [expandedDays, setExpandedDays] = useState<Set<string>>(new Set());
  /** Day whose description is being hand-edited, if any. One at a time. */
  const [editingDay, setEditingDay] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  /** Decimal (5.50) or clock (5:30) — a display choice, so it's remembered locally rather than per-project. */
  const [hoursFormat, setHoursFormat] = useState<HoursFormat>(loadHoursFormat);
  // Redo rewrites a line (costs a request) and undo drops it — both change a
  // billing line, so they sit behind a menu instead of a bare button next to
  // copy. Closing on any outside click or Escape keeps that gate cheap to
  // dismiss rather than one more thing to click through.
  useEffect(() => {
    if (menuDay === null) return;
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent) {
        if (event.key === 'Escape') setMenuDay(null);
        return;
      }
      if (!(event.target instanceof Element) || !event.target.closest('.ts-menu-wrap')) setMenuDay(null);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [menuDay]);

  // Keep the selection valid as projects appear; nothing is persisted.
  useEffect(() => {
    if (selected === '' && billable.length > 0) setSelected(billable[0]!.name);
  }, [billable, selected]);

  // The week boundary is per-project, so a stale guess from the previous
  // project must not leak into the first request for the new one.
  useEffect(() => {
    setWeekOffset(0);
    setWeekStartsOn('monday');
  }, [selected]);

  // At offset 0, the server picks the current billing week itself — sending a
  // guessed range here would win over that and, for a non-Monday week, could
  // ask for a window that does not even align to the client's real week.
  // Away from offset 0 there is always a prior response to base the guess on.
  const from =
    weekOffset === 0 ? null : shiftDays(weekStartOf(today, weekStartsOn), weekOffset * 7);
  const to = from ? shiftDays(from, 6) : null;

  const load = useCallback(async () => {
    if (selected === '') return;
    setBusy(true);
    try {
      const response = await api.timesheet(selected, from ?? undefined, to ?? undefined);
      setData(response);
      setWeekStartsOn(response.billing.weekStartsOn);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [selected, from, to]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Rewrites one day's line from that whole day's activity.
   *
   * The generated line joins session titles, and Claude Code names a session
   * once, from its opening minutes — so a day of many tasks inside one long
   * session shows the name of the first. This reads the day's prompts instead.
   */
  const rewrite = async (day: string) => {
    if (busyDay !== null) return;
    setMenuDay(null);
    setBusyDay(day);
    setGeneratingDay(day);
    setError(null);
    try {
      await api.summariseDay(selected, day);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyDay(null);
      setGeneratingDay(null);
    }
  };

  const revert = async (day: string) => {
    if (busyDay !== null) return;
    setMenuDay(null);
    setBusyDay(day);
    setError(null);
    try {
      await api.clearDaySummary(selected, day);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyDay(null);
    }
  };

  const startEdit = (day: string, current: string) => {
    if (busyDay !== null) return;
    setMenuDay(null);
    setEditingDay(day);
    setEditText(current);
  };

  const cancelEdit = () => {
    setEditingDay(null);
    setEditText('');
  };

  /** Your own wording. Wins over anything generated until removed with `removeNote`. */
  const saveEdit = async (day: string) => {
    const text = editText.trim();
    if (text.length === 0 || busyDay !== null) return;
    setBusyDay(day);
    setError(null);
    try {
      await api.setDayNote(selected, day, text);
      setEditingDay(null);
      setEditText('');
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyDay(null);
    }
  };

  const removeNote = async (day: string) => {
    if (busyDay !== null) return;
    setMenuDay(null);
    setBusyDay(day);
    setError(null);
    try {
      await api.clearDayNote(selected, day);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyDay(null);
    }
  };

  // Escape cancels an in-progress edit. Not outside-click — a stray click while
  // typing a note should not silently throw the draft away.
  useEffect(() => {
    if (editingDay === null) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') cancelEdit();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [editingDay]);

  const toggleHoursFormat = () => {
    setHoursFormat((current) => {
      const next = current === 'decimal' ? 'clock' : 'decimal';
      saveHoursFormat(next);
      return next;
    });
  };

  const copy = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      window.setTimeout(() => setCopied((current) => (current === key ? null : current)), 1200);
    } catch {
      setError('Clipboard blocked by the browser.');
    }
  };

  const toggleExpanded = (day: string) =>
    setExpandedDays((current) => {
      const next = new Set(current);
      if (next.has(day)) next.delete(day);
      else next.add(day);
      return next;
    });

  if (billable.length === 0) {
    return (
      <p className="empty">
        No project has billing rules yet. Add a <code>billing</code> block under{' '}
        <code>projects["&lt;path&gt;"]</code> in <code>~/.traicker/config.json</code>.
      </p>
    );
  }

  const week: TimesheetWeek | undefined = data?.sheet?.weeks[0];
  // The server's actual window, not the client's guess — right away at
  // offset 0, and self-correcting a stale `weekStartsOn` guess everywhere else.
  const displayFrom = data?.range.from ?? from ?? today;
  const displayTo = data?.range.to ?? to ?? today;

  return (
    <div className="timesheet" data-refreshing={busy ? 'true' : undefined}>
      <div className="ts-controls">
        <select value={selected} onChange={(event) => setSelected(event.target.value)}>
          {billable.map((p) => (
            <option key={p.id} value={p.name}>
              {p.name}
              {p.client ? ` · ${p.client}` : ''}
            </option>
          ))}
        </select>

        <div className="ts-week-nav">
          <button onClick={() => setWeekOffset((o) => o - 1)} aria-label="Previous week">
            ‹
          </button>
          <span>
            {shortDate(displayFrom)} – {shortDate(displayTo)}
          </span>
          <button onClick={() => setWeekOffset((o) => o + 1)} disabled={weekOffset >= 0} aria-label="Next week">
            ›
          </button>
          {weekOffset !== 0 && (
            <button className="ts-today" onClick={() => setWeekOffset(0)}>
              This week
            </button>
          )}
        </div>

        {week && (
          <div className={`ts-cap ${week.overCap ? 'over' : ''}`}>
            <strong>{formatHours(week.hours, hoursFormat)}h</strong>
            {week.capHours !== null && <span> / {formatHours(week.capHours, hoursFormat)}h</span>}
            {week.capHours !== null && (
              <span className="ts-cap-bar">
                <span
                  className="ts-cap-fill"
                  style={{ width: `${Math.min(100, (week.hours / week.capHours) * 100)}%` }}
                />
              </span>
            )}
          </div>
        )}

        <button
          className="ts-hours-format"
          onClick={toggleHoursFormat}
          title="Switch how hours are shown — decimal (5.50) or clock (5:30), matching how most client timesheets show them"
        >
          {hoursFormat === 'decimal' ? '5.50' : '5:30'}
        </button>

        {/* Stays in the controls row, which is never dimmed, so the one thing
            that explains the dimming is the one thing at full contrast. */}
        <span className="ts-loading" role="status" aria-live="polite">
          {busy ? 'Loading…' : ''}
        </span>
      </div>

      {error && <div className="error">{error}</div>}

      {/* "No billable time" is a claim about the data, and before the first
          response there is no data to make it about — it read as an answer
          when it was really still a question. */}
      {!data && busy ? (
        <p className="empty">Loading…</p>
      ) : !week || week.entries.length === 0 ? (
        <p className="empty">No billable time in this week.</p>
      ) : (
        <>
          {week.overCap && week.capHours !== null && (
            <div className="ts-warning">
              {formatHours(week.hours - week.capHours, hoursFormat)}h over the {formatHours(week.capHours, hoursFormat)}h
              cap. Reported as measured — trimming to fit the contract is your call.
            </div>
          )}

          <table className="data ts-table">
            <thead>
              <tr>
                <th>Date</th>
                <th className="num">Hours</th>
                <th>Description</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {week.entries.map((entry) => {
                const busy = busyDay === entry.day;
                const generating = generatingDay === entry.day;
                const written = entry.descriptionSource === 'day-summary';
                const yours = entry.descriptionSource === 'manual-note';
                const isLong = entry.description.length > LONG_DESCRIPTION_CHARS;
                const expanded = expandedDays.has(entry.day);
                const editing = editingDay === entry.day;

                return (
                  <tr key={entry.day} className={busy ? 'ts-busy' : undefined}>
                    <td className="ts-date">{shortDate(entry.day)}</td>
                    <td className="num billable">{formatHours(entry.hours, hoursFormat)}</td>
                    <td className="ts-desc">
                      {editing ? (
                        <div className="ts-desc-edit">
                          <textarea
                            value={editText}
                            onChange={(event) => setEditText(event.target.value)}
                            rows={3}
                            autoFocus
                            disabled={busy}
                            placeholder="Write this day's line yourself…"
                          />
                          <div className="ts-desc-edit-actions">
                            <button onClick={() => void saveEdit(entry.day)} disabled={busy || editText.trim().length === 0}>
                              {busy ? 'Saving…' : 'Save'}
                            </button>
                            <button onClick={cancelEdit} disabled={busy}>
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : (
                        <>
                          {(written || yours) && (
                            <div className="ts-desc-tags">
                              {written && (
                                <span
                                  className="ts-src"
                                  title="Written from the whole day's activity. Refresh to redo it."
                                >
                                  rewritten
                                </span>
                              )}
                              {yours && (
                                <span className="ts-src ts-src-yours" title="Your own note. Nothing overwrites it.">
                                  yours
                                </span>
                              )}
                            </div>
                          )}

                          {generating ? (
                            <span className="ts-generating">
                              Reading the day and asking the model to rewrite it — this can take up to a minute…
                            </span>
                          ) : (
                            <span className={isLong && !expanded ? 'ts-desc-clamped' : 'ts-desc-text'}>
                              {entry.description}
                            </span>
                          )}

                          {!generating && isLong && (
                            <button className="ts-desc-toggle" onClick={() => toggleExpanded(entry.day)}>
                              {expanded ? 'show less' : 'show more'}
                            </button>
                          )}
                        </>
                      )}
                    </td>
                    <td className="ts-actions">
                      <div className="ts-action-group">
                        <button
                          className="ts-act-copy"
                          onClick={() => void copy(entry.day, entry.description)}
                          title="Copy the description"
                          disabled={editing}
                        >
                          {copied === entry.day ? 'copied' : 'copy'}
                        </button>

                        <div className={`ts-menu-wrap${menuDay === entry.day ? ' ts-menu-open' : ''}`}>
                          <button
                            className="ts-act-more"
                            onClick={() => setMenuDay((d) => (d === entry.day ? null : entry.day))}
                            disabled={busyDay !== null || editing}
                            aria-haspopup="menu"
                            aria-expanded={menuDay === entry.day}
                            title={
                              busy
                                ? 'Generating — this reads the whole day and can take up to a minute.'
                                : 'Redo, edit, or undo this line'
                            }
                          >
                            {busy ? <span className="ts-spinner" aria-label="Generating…" /> : '⋯'}
                          </button>

                          {menuDay === entry.day && (
                            <div className="ts-menu" role="menu">
                              {/* A manual note is the last word, so redo/refresh (which would
                                  quietly compete with it) only appears before you've written one. */}
                              {!yours && (
                                <button
                                  role="menuitem"
                                  onClick={() => void rewrite(entry.day)}
                                  title="Rewrite this line from the whole day. Sends that day's session titles and prompt excerpts to Claude, stores the result, and costs one request."
                                >
                                  {written ? 'redo' : 'refresh'}
                                </button>
                              )}
                              {written && !yours && (
                                <button
                                  role="menuitem"
                                  className="ts-menu-undo"
                                  onClick={() => void revert(entry.day)}
                                  title="Drop the rewritten line and go back to the joined session titles"
                                >
                                  undo
                                </button>
                              )}
                              <button
                                role="menuitem"
                                onClick={() => startEdit(entry.day, entry.description)}
                                title="Write this day's line yourself. Overrides everything else until removed."
                              >
                                edit
                              </button>
                              {yours && (
                                <button
                                  role="menuitem"
                                  className="ts-menu-undo"
                                  onClick={() => void removeNote(entry.day)}
                                  title="Remove your note and go back to the generated line"
                                >
                                  remove note
                                </button>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          <div className="ts-footer">
            <button
              onClick={() =>
                void copy(
                  'all',
                  week.entries.map((e) => `${e.day}\t${formatHours(e.hours, hoursFormat)}\t${e.description}`).join('\n'),
                )
              }
            >
              {copied === 'all' ? 'Copied all rows' : 'Copy all rows (TSV)'}
            </button>
            {data && !data.configured && (
              <span className="ts-note">
                No billing block for this project — using defaults (occupancy, 15 min rounding, no cap).
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
}

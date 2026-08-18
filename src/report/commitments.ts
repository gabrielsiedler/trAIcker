import { commitmentFor, type CommitmentConfig, type TraickerConfig } from '../core/config.js';
import { listProjects, type Db } from '../core/db.js';
import { MS_PER_DAY, localDay, localOffsetMinutes, toHours, weekStart } from '../core/time.js';

export interface CommitmentStatus {
  projectId: number;
  projectName: string;
  client: string | null;
  weekStart: string;
  weekEnd: string;
  kind: CommitmentConfig['kind'];
  weeklyHours: number;
  /** Hours worked so far this week, on the project's billing basis. */
  hours: number;
  /** Signed difference: positive is above the number, negative is below. */
  deltaHours: number;
  /** True when the arrangement is not being honoured, in whichever direction. */
  breached: boolean;
  /** Elapsed fraction of the week, for judging a target mid-week. */
  weekElapsed: number;
}

/**
 * Weekly progress for every project that has an arrangement.
 *
 * A cap and a target are read in opposite directions: a cap is breached from
 * above, a target from below. Reporting both through one "over/under" number
 * would flag the wrong side for one of them.
 *
 * A target is only judged breached once the week is essentially over — being
 * at 4 of 20 hours on a Tuesday is not a problem, and flagging it would train
 * you to ignore the indicator.
 */
export function commitmentStatuses(db: Db, config: TraickerConfig, now = Date.now()): CommitmentStatus[] {
  const offset = localOffsetMinutes();
  const today = localDay(now, offset);
  const statuses: CommitmentStatus[] = [];

  const hoursQuery = db.prepare(
    `SELECT SUM(s.occupancy_ms) AS occupancy, SUM(s.focus_ms) AS focus
     FROM daily_summary s
     WHERE s.project_id = ? AND s.local_day BETWEEN ? AND ?`,
  );

  for (const project of listProjects(db)) {
    const commitment = commitmentFor(config, project.path);
    if (!commitment) continue;

    const start = weekStart(today, commitment.weekStartsOn);
    const end = shift(start, 6);

    const row = hoursQuery.get(project.id, start, end) as { occupancy: number | null; focus: number | null };
    const basis = config.projects[project.path_key]?.billing?.basis ?? 'occupancy';
    const ms = (basis === 'focus' ? row.focus : row.occupancy) ?? 0;
    const hours = toHours(ms);

    const elapsed = weekElapsedFraction(start, now, offset);
    const delta = Math.round((hours - commitment.weeklyHours) * 100) / 100;

    statuses.push({
      projectId: project.id,
      projectName: project.name,
      client: project.client,
      weekStart: start,
      weekEnd: end,
      kind: commitment.kind,
      weeklyHours: commitment.weeklyHours,
      hours,
      deltaHours: delta,
      breached:
        commitment.kind === 'cap'
          ? hours > commitment.weeklyHours
          : elapsed >= 0.95 && hours < commitment.weeklyHours,
      weekElapsed: elapsed,
    });
  }

  return statuses.sort((a, b) => a.projectName.localeCompare(b.projectName));
}

function shift(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + days * MS_PER_DAY).toISOString().slice(0, 10);
}

/** How much of the week has passed, 0 to 1, in local time. */
function weekElapsedFraction(start: string, now: number, offsetMin: number): number {
  const startMs = Date.parse(`${start}T00:00:00.000Z`) - offsetMin * 60_000;
  const elapsed = (now - startMs) / (7 * MS_PER_DAY);
  return Math.min(1, Math.max(0, elapsed));
}

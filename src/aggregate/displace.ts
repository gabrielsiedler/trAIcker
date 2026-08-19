import { subtractIntervals, toIso, toMs } from '../core/time.js';
import type { ExcludedSpanRow, Interval, Span } from '../core/types.js';

export interface DisplacementResult {
  focus: Span[];
  agent: Span[];
}

/**
 * Removes automatically-captured time that a hand-logged entry supersedes.
 *
 * Two different rules, and the difference is deliberate:
 *
 * - **Focus is cut on every project.** Attention is mutually exclusive; if you
 *   were in a meeting at 14:10 then you were not orchestrating anything else,
 *   whatever the prompt gaps imply.
 *
 * - **Agent time is cut only on the entry's own project.** Billing a meeting
 *   and that project's occupancy for the same half hour would charge it twice.
 *   But four agents building another client's API during your call did real
 *   work, and erasing it would be a worse lie than the one being avoided.
 */
export function applyManualEntries(
  focusSpans: readonly Span[],
  agentSpans: readonly Span[],
  manualSpans: readonly Span[],
): DisplacementResult {
  if (manualSpans.length === 0) {
    return { focus: [...focusSpans], agent: [...agentSpans] };
  }

  const allWindows = manualSpans.map(toInterval);

  const byProject = new Map<number, Interval[]>();
  for (const span of manualSpans) {
    const list = byProject.get(span.project_id) ?? [];
    list.push(toInterval(span));
    byProject.set(span.project_id, list);
  }

  return {
    focus: focusSpans.flatMap((span) => carve(span, allWindows)),
    agent: agentSpans.flatMap((span) => carve(span, byProject.get(span.project_id) ?? [])),
  };
}

/**
 * Rebuilds a span from what survives the cuts.
 *
 * A cut landing in the middle splits one span into two, which is correct: the
 * work resumed after the meeting rather than never having happened.
 */
function carve(span: Span, cuts: readonly Interval[]): Span[] {
  if (cuts.length === 0) return [span];

  const remaining = subtractIntervals([toInterval(span)], cuts);
  if (remaining.length === 0) return [];

  const originalEnd = toMs(span.end_utc);

  return remaining.map((piece) => ({
    ...span,
    start_utc: toIso(piece.start),
    end_utc: toIso(piece.end),
    duration_ms: piece.end - piece.start,
    // Only the piece that still reaches the original end keeps the reason the
    // span stopped; the others end because they were displaced.
    truncated_by: piece.end === originalEnd ? span.truncated_by : null,
  }));
}

function toInterval(span: Span): Interval {
  return { start: toMs(span.start_utc), end: toMs(span.end_utc) };
}

/**
 * Carves known-wrong windows out of agent time, project by project.
 *
 * Deliberately never touches focus, and never on any project but its own: an
 * exclusion is a correction to one project's record, not a claim about where
 * you were. See `ExcludedSpanRow` for why this is a separate mechanism from a
 * manual entry rather than another `ManualKind`.
 */
export function applyExclusions(agentSpans: readonly Span[], exclusions: readonly ExcludedSpanRow[]): Span[] {
  if (exclusions.length === 0) return [...agentSpans];

  const byProject = new Map<number, Interval[]>();
  for (const exclusion of exclusions) {
    const list = byProject.get(exclusion.project_id) ?? [];
    list.push({ start: toMs(exclusion.start_utc), end: toMs(exclusion.end_utc) });
    byProject.set(exclusion.project_id, list);
  }

  return agentSpans.flatMap((span) => carve(span, byProject.get(span.project_id) ?? []));
}

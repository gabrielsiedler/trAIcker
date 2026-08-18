import { MS_PER_MINUTE, mergeIntervals, toIso, toMs } from '../core/time.js';
import type { Interval, Span, TitleSource } from '../core/types.js';

export interface OccupancyOptions {
  /** Gaps at or below this are absorbed rather than splitting a block. */
  stitchGapMinutes: number;
}

/**
 * Derives the billable timeline: how long each project was being worked on, by
 * you or by an agent you directed.
 *
 * This is the number an hourly client is buying. Focus alone would describe you
 * as a project manager who glanced at the work for ten minutes; it does not
 * describe an API with tests that exists because of a decision you made. An
 * agent that flounders for an hour is billed the same way a slower engineer's
 * hour is billed — hourly work has always priced input with variable output,
 * corrected by rate rather than by measuring deliverables.
 *
 * Occupancy overlaps across projects on purpose. It is not a claim of exclusive
 * attention, and must never be presented as one.
 *
 * Input spans must already be split at local midnight; blocks are built within
 * a single day so daily totals stay additive.
 */
export function computeOccupancySpans(spans: readonly Span[], options: OccupancyOptions): Span[] {
  const stitchMs = options.stitchGapMinutes * MS_PER_MINUTE;
  const groups = new Map<string, Span[]>();

  for (const span of spans) {
    if (span.bucket === 'occupancy') continue; // never fold a previous pass back in
    const key = `${span.local_day}|${span.project_id}`;
    const list = groups.get(key);
    if (list) list.push(span);
    else groups.set(key, [span]);
  }

  const result: Span[] = [];

  for (const group of groups.values()) {
    const intervals: Interval[] = group.map((s) => ({ start: toMs(s.start_utc), end: toMs(s.end_utc) }));
    const blocks = stitch(mergeIntervals(intervals), stitchMs);
    const first = group[0]!;

    for (const block of blocks) {
      const dominant = dominantLabel(group, block);
      result.push({
        bucket: 'occupancy',
        source: 'billable_block',
        project_id: first.project_id,
        session_id: dominantSession(group, block),
        agent_id: null,
        agent_type: null,
        title: dominant.title,
        title_source: dominant.source,
        local_day: first.local_day,
        start_utc: toIso(block.start),
        end_utc: toIso(block.end),
        duration_ms: block.end - block.start,
        truncated_by: null,
      });
    }
  }

  return result;
}

/**
 * Joins intervals separated by no more than `stitchMs`.
 *
 * The gap between an agent finishing and your next prompt is not a pause in the
 * work — it is you reading the output. Nothing emits an event while you read,
 * so the hole is an artefact of the instrumentation rather than of the day.
 */
function stitch(merged: readonly Interval[], stitchMs: number): Interval[] {
  if (merged.length === 0) return [];

  const blocks: Interval[] = [{ ...merged[0]! }];

  for (let i = 1; i < merged.length; i++) {
    const current = merged[i]!;
    const last = blocks[blocks.length - 1]!;
    if (current.start - last.end <= stitchMs) last.end = Math.max(last.end, current.end);
    else blocks.push({ ...current });
  }

  return blocks;
}

/**
 * The label covering the most of the block — its one-line description.
 *
 * The source travels with it, because that is what decides whether the label
 * may appear on a client's timesheet.
 */
function dominantLabel(group: readonly Span[], block: Interval): { title: string | null; source: TitleSource } {
  const weights = new Map<string, { weight: number; source: TitleSource }>();

  for (const span of group) {
    if (span.title === null) continue;
    const overlap = overlapMs(span, block);
    if (overlap <= 0) continue;

    const existing = weights.get(span.title);
    if (existing) existing.weight += overlap;
    else weights.set(span.title, { weight: overlap, source: span.title_source });
  }

  let best: string | null = null;
  let bestWeight = 0;
  let bestSource: TitleSource = 'session_title';

  for (const [title, entry] of weights) {
    if (entry.weight > bestWeight) {
      best = title;
      bestWeight = entry.weight;
      bestSource = entry.source;
    }
  }

  return { title: best, source: bestSource };
}

function dominantSession(group: readonly Span[], block: Interval): string {
  const weights = new Map<string, number>();

  for (const span of group) {
    const overlap = overlapMs(span, block);
    if (overlap > 0) weights.set(span.session_id, (weights.get(span.session_id) ?? 0) + overlap);
  }

  let best = group[0]!.session_id;
  let bestWeight = -1;
  for (const [session, weight] of weights) {
    if (weight > bestWeight) {
      best = session;
      bestWeight = weight;
    }
  }
  return best;
}

function overlapMs(span: Span, block: Interval): number {
  return Math.max(0, Math.min(toMs(span.end_utc), block.end) - Math.max(toMs(span.start_utc), block.start));
}

import { MS_PER_MINUTE, splitAtLocalMidnight, toIso, toMs } from '../core/time.js';
import type { EventRow, Span } from '../core/types.js';
import { labelFor, type TaskIndex } from './tasks.js';

export interface IdleDrop {
  project_id: number;
  local_day: string;
  ms: number;
}

export interface FocusResult {
  spans: Span[];
  idleDrops: IdleDrop[];
}

export interface FocusOptions {
  /** Task windows, so a span is labelled by what you declared you were on. */
  tasks?: TaskIndex | null;
  idleTimeoutMinutes: number;
  /**
   * Ceiling on how much of one gap is reported as discarded idle. A longer gap
   * is off the clock rather than idle, and is not attributed at all.
   */
  idleAttributionCapMinutes: number;
  /** Evaluation instant; injected so tests are deterministic. */
  now: number;
}

/**
 * Builds the focus timeline: the sequential, mutually-exclusive record of where
 * your attention actually was.
 *
 * The model is that a prompt claims your attention until the next prompt lands
 * *anywhere*. Submitting to project B implicitly ends focus on project A — which
 * is why no toggle is needed, and why the events must be ordered globally rather
 * than per session.
 *
 * Mutual exclusivity is a property of the construction, not something enforced
 * afterwards: every span is a subinterval of `[prompt_i, prompt_i+1)`, and those
 * intervals are disjoint by definition. There is no overlap resolution step
 * because overlap cannot occur.
 *
 * The idle cap is what stops "I went to lunch" from being billed. An interval
 * runs at most `idleTimeoutMinutes`; anything beyond that is dead time,
 * recorded separately so it stays visible rather than silently vanishing.
 *
 * @param prompts UserPromptSubmit events from the main loop, globally sorted by
 *                timestamp. Subagent events must not appear here — a subagent
 *                never competes for your attention.
 */
export function computeFocusSpans(prompts: readonly EventRow[], options: FocusOptions): FocusResult {
  const idleCapMs = options.idleTimeoutMinutes * MS_PER_MINUTE;
  const attributionCapMs = options.idleAttributionCapMinutes * MS_PER_MINUTE;
  const spans: Span[] = [];
  const drops = new Map<string, IdleDrop>();

  for (let i = 0; i < prompts.length; i++) {
    const prompt = prompts[i]!;
    const next = prompts[i + 1];

    const start = toMs(prompt.ts_utc);
    const cap = start + idleCapMs;

    let end: number;
    let truncated: Span['truncated_by'] = null;

    if (next) {
      const nextStart = toMs(next.ts_utc);
      if (nextStart > cap) {
        end = cap;
        truncated = 'idle_timeout';
        recordDrop(drops, prompt, cap, nextStart, attributionCapMs);
      } else {
        end = nextStart;
      }
    } else {
      // The most recent prompt. Focus is credited up to now, still capped: an
      // abandoned session must not accrue time forever.
      end = Math.min(options.now, cap);
      if (options.now > cap) {
        truncated = 'idle_timeout';
        recordDrop(drops, prompt, cap, options.now, attributionCapMs);
      } else {
        truncated = 'open';
      }
    }

    if (end <= start) continue;

    const label = labelFor(prompt, options.tasks ?? null);

    for (const slice of splitAtLocalMidnight(start, end, prompt.tz_offset_min)) {
      spans.push({
        bucket: 'focus',
        source: 'prompt_gap',
        project_id: prompt.project_id,
        session_id: prompt.session_id,
        agent_id: null,
        agent_type: null,
        title: label.title,
        title_source: label.source,
        local_day: slice.localDay,
        start_utc: toIso(slice.start),
        end_utc: toIso(slice.end),
        duration_ms: slice.end - slice.start,
        // Only the slice that actually hits the boundary carries the reason.
        truncated_by: slice.end === end ? truncated : null,
      });
    }
  }

  return { spans, idleDrops: [...drops.values()] };
}

/**
 * Attributes discarded idle time to the project that held focus when you walked
 * away, split across local days so daily totals stay consistent.
 *
 * The attribution is capped per gap. An overnight or weekend gap is not idle
 * time, it is time off the clock; counting it would make the figure dominated
 * by hours nobody was ever going to work, and hide the interruptions the metric
 * exists to reveal.
 */
function recordDrop(
  drops: Map<string, IdleDrop>,
  prompt: EventRow,
  from: number,
  to: number,
  attributionCapMs: number,
): void {
  const end = Math.min(to, from + attributionCapMs);
  if (end <= from) return;

  for (const slice of splitAtLocalMidnight(from, end, prompt.tz_offset_min)) {
    const key = `${slice.localDay}|${prompt.project_id}`;
    const existing = drops.get(key);
    if (existing) existing.ms += slice.end - slice.start;
    else drops.set(key, { project_id: prompt.project_id, local_day: slice.localDay, ms: slice.end - slice.start });
  }
}

/**
 * Label for a block of work. See `labelFor` for the precedence and why.
 *
 * Kept as a thin alias so callers that do not have a task index still resolve a
 * sensible label.
 */
export function titleOf(event: EventRow, tasks: TaskIndex | null = null): string | null {
  return labelFor(event, tasks).title;
}

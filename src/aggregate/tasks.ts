import { MS_PER_MINUTE, toMs } from '../core/time.js';
import type { EventRow, TitleSource } from '../core/types.js';

/** Ceiling for a task that was created and never completed. */
const MAX_TASK_MINUTES = 480;

interface TaskWindow {
  start: number;
  end: number;
  subject: string;
}

export interface Label {
  title: string | null;
  source: TitleSource;
}

/**
 * Resolves what was being worked on at a given instant.
 *
 * Precedence is deliberate and not arbitrary:
 *
 * 1. `task` — a boundary you declared, with a real start and end. The only
 *    source that changes within a session.
 * 2. `prompt_excerpt` — raw text you typed. Worse prose than the session
 *    title, but it changes every prompt, where the session title does not.
 * 3. `session_title` — Claude Code's generated title. Reads better, but is
 *    produced once per session and never revised, so a long session without
 *    declared tasks would otherwise collapse to one topic for its full length.
 *
 * The excerpt outranks the session title because a timeline that always shows
 * the first prompt's topic is worse than one with rougher labels that actually
 * move; tasks outrank both because they are the only thing that actually
 * tracks a change of subject.
 */
export function buildTaskIndex(events: readonly EventRow[]) {
  const created = new Map<string, EventRow>();
  const completed = new Map<string, number>();

  for (const event of events) {
    if (!event.task_id) continue;

    if (event.event_type === 'TaskCreated') {
      if (!created.has(event.task_id)) created.set(event.task_id, event);
    } else if (event.event_type === 'TaskCompleted') {
      const at = toMs(event.ts_utc);
      const existing = completed.get(event.task_id);
      // Keep the earliest completion: a task re-reported later must not stretch
      // the window over work that belonged to something else.
      if (existing === undefined || at < existing) completed.set(event.task_id, at);
    }
  }

  const bySession = new Map<string, TaskWindow[]>();

  for (const [taskId, event] of created) {
    if (!event.task_subject) continue;

    const start = toMs(event.ts_utc);
    const ceiling = start + MAX_TASK_MINUTES * MS_PER_MINUTE;
    const end = Math.min(completed.get(taskId) ?? ceiling, ceiling);
    if (end <= start) continue;

    const list = bySession.get(event.session_id) ?? [];
    list.push({ start, end, subject: event.task_subject });
    bySession.set(event.session_id, list);
  }

  for (const list of bySession.values()) list.sort((a, b) => a.start - b.start);

  return {
    /**
     * The task covering `at`, if any.
     *
     * Tasks overlap freely — several can be open at once — so the most recently
     * started one wins. That matches how a task list is actually used: you open
     * the next thing, and that is what you are on.
     */
    taskAt(sessionId: string, at: number): string | null {
      const list = bySession.get(sessionId);
      if (!list) return null;

      let best: string | null = null;
      for (const window of list) {
        if (window.start > at) break;
        if (at < window.end) best = window.subject;
      }
      return best;
    },

    get size(): number {
      let total = 0;
      for (const list of bySession.values()) total += list.length;
      return total;
    },
  };
}

export type TaskIndex = ReturnType<typeof buildTaskIndex>;

/** Applies the precedence above to one event. */
export function labelFor(event: EventRow, tasks: TaskIndex | null): Label {
  const task = tasks?.taskAt(event.session_id, toMs(event.ts_utc)) ?? null;
  if (task) return { title: task, source: 'task' };
  if (event.prompt_excerpt) return { title: event.prompt_excerpt, source: 'prompt_excerpt' };
  if (event.session_title) return { title: event.session_title, source: 'session_title' };
  return { title: null, source: 'session_title' };
}

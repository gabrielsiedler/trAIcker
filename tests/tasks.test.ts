import { describe, expect, it } from 'vitest';

import { buildTaskIndex, labelFor } from '../src/aggregate/tasks.js';
import type { EventRow, TrackedEvent } from '../src/core/types.js';

const MIN = 60_000;
const BASE = Date.parse('2026-08-10T12:00:00.000Z');

let nextId = 1;

function event(type: TrackedEvent, atMin: number, overrides: Partial<EventRow> = {}): EventRow {
  return {
    id: nextId++,
    event_uid: `uid-${nextId}`,
    event_type: type,
    ts_utc: new Date(BASE + atMin * MIN).toISOString(),
    tz_offset_min: -180,
    project_id: 1,
    session_id: 's1',
    agent_id: null,
    agent_type: null,
    prompt_id: null,
    reason: null,
    session_title: null,
    prompt_chars: null,
    prompt_excerpt: null,
    task_id: null,
    task_subject: null,
    duration_ms: null,
    source: 'hook' as const,
    payload_json: '{}',
    ingested_at: new Date(BASE).toISOString(),
    ...overrides,
  };
}

const at = (min: number) => BASE + min * MIN;

describe('buildTaskIndex', () => {
  it('labels an instant with the task open at that moment', () => {
    const tasks = buildTaskIndex([
      event('TaskCreated', 0, { task_id: 't1', task_subject: 'Build the API' }),
      event('TaskCompleted', 30, { task_id: 't1', task_subject: 'Build the API' }),
    ]);

    expect(tasks.taskAt('s1', at(10))).toBe('Build the API');
    expect(tasks.taskAt('s1', at(40))).toBeNull();
  });

  it('splits one session into separate topics — the whole point', () => {
    // A single session with one generated title, moving through three jobs.
    const tasks = buildTaskIndex([
      event('TaskCreated', 0, { task_id: 't1', task_subject: 'Scaffold the core' }),
      event('TaskCompleted', 40, { task_id: 't1', task_subject: 'Scaffold the core' }),
      event('TaskCreated', 45, { task_id: 't2', task_subject: 'Write the hook' }),
      event('TaskCompleted', 90, { task_id: 't2', task_subject: 'Write the hook' }),
    ]);

    expect(tasks.taskAt('s1', at(20))).toBe('Scaffold the core');
    expect(tasks.taskAt('s1', at(60))).toBe('Write the hook');
  });

  it('gives the most recently started task when several are open', () => {
    const tasks = buildTaskIndex([
      event('TaskCreated', 0, { task_id: 't1', task_subject: 'Long running' }),
      event('TaskCreated', 20, { task_id: 't2', task_subject: 'Started later' }),
      event('TaskCompleted', 60, { task_id: 't2', task_subject: 'Started later' }),
      event('TaskCompleted', 90, { task_id: 't1', task_subject: 'Long running' }),
    ]);

    expect(tasks.taskAt('s1', at(10))).toBe('Long running');
    // Opening the next thing is what you are on.
    expect(tasks.taskAt('s1', at(30))).toBe('Started later');
    expect(tasks.taskAt('s1', at(70))).toBe('Long running');
  });

  it('caps a task that was never completed', () => {
    const tasks = buildTaskIndex([event('TaskCreated', 0, { task_id: 't1', task_subject: 'Forgotten' })]);

    expect(tasks.taskAt('s1', at(60))).toBe('Forgotten');
    expect(tasks.taskAt('s1', at(600))).toBeNull(); // past the 8h ceiling
  });

  it('keeps tasks from different sessions apart', () => {
    const tasks = buildTaskIndex([
      event('TaskCreated', 0, { task_id: 't1', task_subject: 'Client A work', session_id: 'sa' }),
      event('TaskCreated', 0, { task_id: 't2', task_subject: 'Client B work', session_id: 'sb' }),
    ]);

    expect(tasks.taskAt('sa', at(10))).toBe('Client A work');
    expect(tasks.taskAt('sb', at(10))).toBe('Client B work');
  });

  it('ignores a task with no subject', () => {
    const tasks = buildTaskIndex([event('TaskCreated', 0, { task_id: 't1' })]);
    expect(tasks.size).toBe(0);
  });

  it('does not let a repeated completion stretch a window', () => {
    const tasks = buildTaskIndex([
      event('TaskCreated', 0, { task_id: 't1', task_subject: 'Done early' }),
      event('TaskCompleted', 20, { task_id: 't1', task_subject: 'Done early' }),
      event('TaskCompleted', 90, { task_id: 't1', task_subject: 'Done early' }),
    ]);

    expect(tasks.taskAt('s1', at(50))).toBeNull();
  });
});

describe('labelFor', () => {
  const tasks = buildTaskIndex([
    event('TaskCreated', 0, { task_id: 't1', task_subject: 'Refactor billing' }),
    event('TaskCompleted', 60, { task_id: 't1', task_subject: 'Refactor billing' }),
  ]);

  it('prefers a declared task over everything', () => {
    const prompt = event('UserPromptSubmit', 10, {
      session_title: 'Session-wide title',
      prompt_excerpt: 'raw text I typed',
    });

    expect(labelFor(prompt, tasks)).toEqual({ title: 'Refactor billing', source: 'task' });
  });

  it('prefers the prompt excerpt over the session title outside any task', () => {
    const prompt = event('UserPromptSubmit', 90, {
      session_title: 'Session-wide title',
      prompt_excerpt: 'raw text I typed',
    });

    expect(labelFor(prompt, tasks)).toEqual({ title: 'raw text I typed', source: 'prompt_excerpt' });
  });

  it('falls back to the session title when there is no excerpt', () => {
    const prompt = event('UserPromptSubmit', 90, { session_title: 'Session-wide title' });

    expect(labelFor(prompt, tasks)).toEqual({ title: 'Session-wide title', source: 'session_title' });
  });

  it('returns no label when there is nothing to say', () => {
    expect(labelFor(event('UserPromptSubmit', 90), null).title).toBeNull();
  });
});

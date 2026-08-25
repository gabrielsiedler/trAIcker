/**
 * Translates DSH session events into trAIcker `SpoolRecord` lines.
 *
 * The mapping is lossy by design: only the fields the ingest pipeline
 * understands are written. Token usage is carried separately (see usage.ts).
 *
 * Self-contained: no imports from the trAIcker codebase.
 *
 * @module @traicker/dsh-plugin/capture
 */

import type { SpoolRecord, TrackedEvent } from './types.js';
import type {
  AssistantMessageData,
  HookResultData,
  SessionHeaderData,
  UserMessageData,
} from './types.js';

/** Collapses whitespace and truncates, keeping results single-line. */
function clip(value: string, max: number): string | null {
  const flat = value.replace(/\s+/g, ' ').trim();
  if (flat.length === 0) return null;
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/**
 * Normalise a filesystem path to canonical form: absolute, forward slashes,
 * uppercase drive letter, no trailing separator.
 *
 * Reimplements trAIcker's normalizePath so the plugin has zero dependency
 * on the trAIcker codebase. Uses path.resolve from node:path directly.
 */
import { resolve } from 'node:path';

export function normalizePath(input: string): string {
  const trimmed = input.trim();
  let p: string;
  if (trimmed.startsWith('/') || /^[A-Za-z]:[/\\]/.test(trimmed)) {
    p = trimmed;
  } else {
    p = resolve(process.cwd(), trimmed);
  }
  p = p.replace(/\\/g, '/');
  if (/^[a-z]:/.test(p)) p = p[0]!.toUpperCase() + p.slice(1);
  if (p.length > 1 && p.endsWith('/') && !/^[A-Za-z]:\/$/.test(p)) p = p.slice(0, -1);
  return p;
}

/**
 * Build a SpoolRecord with the common fields prefilled.
 */
function baseRecord(
  eventType: TrackedEvent,
  tsIso: string,
  tzOffset: number,
  session: SessionHeaderData,
): Pick<
  SpoolRecord,
  'v' | 'e' | 't' | 'tz' | 'cwd' | 'sid' | 'aid' | 'at' | 'pid' | 'r' | 'plen' | 'ex' | 'dur' | 'ttl' | 'tid' | 'tsub'
> {
  return {
    v: 1 as const,
    e: eventType,
    t: tsIso,
    tz: tzOffset,
    cwd: normalizePath(session.cwd),
    sid: session.id,
    aid: null,
    at: null,
    pid: null,
    r: null,
    plen: null,
    ex: null,
    dur: null,
    ttl: null,
    tid: null,
    tsub: null,
  };
}

/**
 * Map a DSH `hook/result` whose `point` is `UserPromptSubmit` to a
 * `UserPromptSubmit` spool record.
 */
export function fromUserPromptHook(
  data: HookResultData,
  tsIso: string,
  tzOffset: number,
  session: SessionHeaderData,
): SpoolRecord {
  return {
    ...baseRecord('UserPromptSubmit', tsIso, tzOffset, session),
    r: data.decision !== 'pass' ? `hook:${data.decision}` : null,
  } satisfies SpoolRecord;
}

/**
 * Map a DSH `hook/result` whose `point` is `PostToolUse` (matched to `Task`)
 * to a `PostToolUse` spool record — i.e. a subagent run.
 */
export function fromPostToolUse(
  data: HookResultData,
  tsIso: string,
  tzOffset: number,
  session: SessionHeaderData,
): SpoolRecord | null {
  if (data.matcher !== 'Task') return null;

  return {
    ...baseRecord('PostToolUse', tsIso, tzOffset, session),
    dur: Number.isFinite(data.durationMs) && data.durationMs >= 0
      ? Math.round(data.durationMs)
      : null,
    r: data.decision !== 'pass' ? `hook:${data.decision}` : null,
    at: 'general-purpose',
    aid: data.handlerId,
  } satisfies SpoolRecord;
}

/**
 * Map a DSH `hook/result` whose `point` is `Stop` to a `Stop` spool record.
 */
export function fromStop(
  data: HookResultData,
  tsIso: string,
  tzOffset: number,
  session: SessionHeaderData,
): SpoolRecord {
  return {
    ...baseRecord('Stop', tsIso, tzOffset, session),
    r: data.decision !== 'pass' ? `hook:${data.decision}` : null,
  } satisfies SpoolRecord;
}

/**
 * Map a DSH `user/message` that is a direct user prompt to a
 * `UserPromptSubmit` spool record.
 */
export function fromUserMessage(
  data: UserMessageData,
  tsIso: string,
  tzOffset: number,
  session: SessionHeaderData,
  excerptChars: number,
): SpoolRecord | null {
  if (data.injected) return null;

  const content = extractText(data.content);
  let plen: number | null = null;
  let ex: string | null = null;

  if (content !== null) {
    plen = content.length;
    ex = excerptChars > 0 ? clip(content, Math.min(excerptChars, 200)) : null;
  }

  return {
    ...baseRecord('UserPromptSubmit', tsIso, tzOffset, session),
    plen,
    ex,
  } satisfies SpoolRecord;
}

/**
 * Map a session creation to a `SessionStart` spool record.
 */
export function fromSessionStart(
  tsIso: string,
  tzOffset: number,
  session: SessionHeaderData,
  source: string,
): SpoolRecord {
  return {
    ...baseRecord('SessionStart', tsIso, tzOffset, session),
    r: source,
  } satisfies SpoolRecord;
}

/**
 * Map a `turn/start` event — only the first turn (turn 1) produces a record.
 */
export function fromTurnStart(
  turnNumber: number,
  tsIso: string,
  tzOffset: number,
  session: SessionHeaderData,
): SpoolRecord | null {
  if (turnNumber !== 1) return null;

  return {
    ...baseRecord('SessionStart', tsIso, tzOffset, session),
    r: 'turn/start',
  } satisfies SpoolRecord;
}

/**
 * Map a `turn/end` event to a `SessionEnd` spool record.
 */
export function fromTurnEnd(
  tsIso: string,
  tzOffset: number,
  session: SessionHeaderData,
  reason: string,
): SpoolRecord {
  return {
    ...baseRecord('SessionEnd', tsIso, tzOffset, session),
    r: reason,
  } satisfies SpoolRecord;
}

/** Extract plain text from DSH content blocks (text only). */
function extractText(content: unknown[]): string | null {
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === 'object' && block !== null) {
      const b = block as Record<string, unknown>;
      if (b['type'] === 'text' && typeof b['text'] === 'string') {
        parts.push(b['text']);
      }
    }
  }
  return parts.length > 0 ? parts.join('\n') : null;
}
/**
 * Captures token usage from DSH `assistant/message` events.
 *
 * Unlike the hook path (which parses Claude Code transcripts to approximate
 * cost), the DSH publishes exact `usage` on every `assistant/message` event.
 * This module writes directly to `model_usage` so the cost rollup reflects
 * the real numbers.
 *
 * The write is best-effort: a failure (DB locked, bad data) is logged and
 * dropped. The agent must never wait on trAIcker's database.
 */

import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { AssistantMessageData, TokenUsagePayload } from './types.js';

/**
 * Message id used as the dedup key in `model_usage.message_id`.
 *
 * DSH does not assign a message id to `assistant/message` events the way
 * Claude Code's transcript does. We derive one from the session + turn +
 * step so the same turn is never double-counted.
 */
function usageUid(sessionId: string, turn: number, step: number): string {
  return createHash('sha1')
    .update(`dsh:${sessionId}:${turn}:${step}`)
    .digest('hex');
}

/**
 * The model name from an `assistant/message` event.
 *
 * DSH logs the model in `request/header` and `assistant/message` carries
 * the provider+model on the message envelope. Fall back to the string from
 * the message content when available.
 */
function extractModel(data: AssistantMessageData): string | null {
  const msg = data.message;
  if (typeof msg === 'object' && msg !== null) {
    const m = msg as Record<string, unknown>;
    if (typeof m['model'] === 'string' && m['model'].length > 0) return m['model'];
    if (typeof m['provider'] === 'string' && typeof m['model'] === 'string') {
      return `${m['provider']}/${m['model']}`;
    }
  }
  return null;
}

/**
 * Best-effort insert of one token usage row.
 *
 * Returns `true` when the row was inserted, `false` on duplicate or error.
 * Never throws — the caller (a Cordis event listener) must not be disrupted
 * by a storage failure.
 */
export function insertUsage(
  db: Database.Database,
  projectId: number,
  sessionId: string,
  localDay: string,
  tsIso: string,
  turn: number,
  step: number,
  usage: TokenUsagePayload,
  modelName: string | null,
): boolean {
  try {
    const uid = usageUid(sessionId, turn, step);
    const model = modelName ?? 'unknown';

    const info = db
      .prepare(
        `INSERT OR IGNORE INTO model_usage (
           message_id, project_id, session_id, local_day, ts_utc, model,
           input_tokens, output_tokens,
           cache_creation_input_tokens, cache_read_input_tokens
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        uid,
        projectId,
        sessionId,
        localDay,
        tsIso,
        model,
        usage.inputTokens,
        usage.outputTokens,
        usage.cacheWriteTokens ?? 0,
        usage.cacheReadTokens ?? 0,
      );

    return info.changes > 0;
  } catch {
    return false;
  }
}
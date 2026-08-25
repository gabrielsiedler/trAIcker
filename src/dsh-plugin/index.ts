/**
 * trAIcker DSH plugin — Cordis plugin that bridges DeepSeek Harness events
 * into trAIcker's NDJSON spool.
 *
 * ## What it captures
 *
 * | DSH event | trAIcker event | Source |
 * |---|---|---|
 * | `session/event` type `user/message` (direct) | `UserPromptSubmit` | prompt length + excerpt |
 * | `session/event` type `assistant/message` with `usage` | `model_usage` | exact token cost |
 * | `session/event` type `hook/result` point `UserPromptSubmit` | `UserPromptSubmit` | fallback when no surface event |
 * | `session/event` type `hook/result` point `PostToolUse` + matcher `Task` | `PostToolUse` | subagent run with duration |
 * | `session/event` type `hook/result` point `Stop` | `Stop` | turn stop |
 * | `session/event` type `turn/start` (first turn) | `SessionStart` | session opened |
 * | `session/event` type `turn/end` | `SessionEnd` | session/cycle closed |
 * | `session/created` | `SessionStart` | session created |
 *
 * ## Installation
 *
 * In your DSH profile's `cordis.patch.yml`:
 *
 * ```yaml
 * - insert:
 *     - id: traicker
 *       name: '@traicker/dsh-plugin'
 *       config:
 *         spoolDir: /home/user/.traicker/spool
 *         dbPath: /home/user/.traicker/time.db
 *         promptExcerptChars: 80
 * ```
 *
 * ## Design constraints
 *
 * - NEVER blocks the agent. All writes are best-effort.
 * - Spool records match what trAIcker's `hook.ts` produces, so the
 *   existing `ingest` + `aggregate` pipeline works unchanged.
 * - Token usage goes directly to SQLite via `model_usage`.
 *
 * @module @traicker/dsh-plugin
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { appendSpoolRecord } from './spool.js';
import {
  fromUserMessage,
  fromUserPromptHook,
  fromPostToolUse,
  fromStop,
  fromSessionStart,
  fromTurnStart,
  fromTurnEnd,
} from './capture.js';
import type {
  HookResultData,
  SessionHeaderData,
  UserMessageData,
} from './types.js';

export const name = 'traicker';

/**
 * Plugin config — paths to trAIcker's state.
 */
export interface Config {
  /** trAIcker spool directory. */
  spoolDir?: string;
  /** trAIcker database path. */
  dbPath?: string;
  /**
   * How many characters of the first prompt to keep as a fallback label.
   * 0 stores no prompt text. Default: 80.
   */
  promptExcerptChars?: number;
}

/**
 * Minimal Cordis context type that the plugin uses.
 *
 * At runtime this is a full `Context` from `@deepseek-ai/cordis`.
 * Only `ctx.on()`, `ctx.logger`, and `ctx.effect()` are used.
 */
interface CordisContext {
  on(event: string, handler: (...args: unknown[]) => void): void;
  logger: { warn: (msg: string) => void; info: (msg: string) => void };
  effect(fn: () => () => void, name?: string): void;
}

export const Config = undefined;

export function apply(ctx: CordisContext, config: Config): void {
  // Resolve paths: explicit config wins, then try loading trAIcker's config.
  const { spoolDir, dbPath, excerptChars } = resolveConfig(config, ctx);

  if (!spoolDir) {
    ctx.logger.warn(
      'traicker: no spoolDir configured and no trAIcker config found. ' +
        'Set spoolDir in the plugin config.',
    );
    return;
  }

  const tzOffset = localOffsetMinutes();

  // Track sessions we have already seen (to avoid double SessionStart).
  const startedSessions = new Set<string>();

  /**
   * `session/event` fires for every appended session event (post-commit).
   * This is the main feed.
   */
  ctx.on('session/event', (...args: unknown[]) => {
    const session = args[0] as { header: SessionHeaderData };
    const event = args[1] as {
      type: string;
      time: number;
      data: Record<string, unknown>;
    };

    const header = session.header;
    const now = new Date(event.time);
    const tsIso = now.toISOString();

    switch (event.type) {
      // ── user/message ──────────────────────────────────────────────
      case 'user/message': {
        const data = event.data as unknown as UserMessageData;
        const record = fromUserMessage(data, tsIso, tzOffset, header, excerptChars);
        if (record) {
          startedSessions.add(header.id);
          appendSpoolRecord(spoolDir, record.sid, record.t, record.tz, record);
        }
        break;
      }

      // ── assistant/message (with usage) ────────────────────────────
      //
      // Token cost is captured LATER by trAIcker's ingest, which resolves the
      // correct project_id (model_usage.project_id has a FK, so the plugin
      // cannot write it safely). Cost capture is a follow-up phase; this
      // listener currently records no cost data.
      case 'assistant/message':
        break;

      // ── hook/result ───────────────────────────────────────────────
      case 'hook/result': {
        const data = event.data as unknown as HookResultData;

        if (data.point === 'UserPromptSubmit') {
          const record = fromUserPromptHook(data, tsIso, tzOffset, header);
          startedSessions.add(header.id);
          appendSpoolRecord(spoolDir, record.sid, record.t, record.tz, record);
        } else if (data.point === 'PostToolUse' && data.matcher === 'Task') {
          const record = fromPostToolUse(data, tsIso, tzOffset, header);
          if (record) {
            appendSpoolRecord(spoolDir, record.sid, record.t, record.tz, record);
          }
        } else if (data.point === 'Stop') {
          const record = fromStop(data, tsIso, tzOffset, header);
          appendSpoolRecord(spoolDir, record.sid, record.t, record.tz, record);
        }
        break;
      }

      // ── turn/start ────────────────────────────────────────────────
      case 'turn/start': {
        const turn = (event.data as { turn: number }).turn;
        const record = fromTurnStart(turn, tsIso, tzOffset, header);
        if (record) {
          startedSessions.add(header.id);
          appendSpoolRecord(spoolDir, record.sid, record.t, record.tz, record);
        }
        break;
      }

      // ── turn/end ──────────────────────────────────────────────────
      case 'turn/end': {
        if (!startedSessions.has(header.id)) break;
        startedSessions.delete(header.id);

        const reasonData = event.data as { reason: { kind: string } };
        const reason =
          typeof reasonData.reason?.kind === 'string'
            ? reasonData.reason.kind
            : 'unknown';
        const record = fromTurnEnd(tsIso, tzOffset, header, reason);
        appendSpoolRecord(spoolDir, record.sid, record.t, record.tz, record);
        break;
      }

      default:
        break;
    }
  });

  // ── session/created ─────────────────────────────────────────────
  ctx.on('session/created', (...args: unknown[]) => {
    const session = args[0] as { header: SessionHeaderData };
    const header = session.header;
    if (startedSessions.has(header.id)) return;

    const now = new Date();
    const tsIso = now.toISOString();
    const record = fromSessionStart(tsIso, tzOffset, header, 'dsh');
    startedSessions.add(header.id);
    appendSpoolRecord(spoolDir, record.sid, record.t, record.tz, record);
  });

  // Cleanup on dispose.
  ctx.effect(() => {
    return () => {
      startedSessions.clear();
    };
  }, 'traicker: cleanup');
}

/**
 * Current local UTC offset in minutes (e.g. -180 for UTC-3).
 *
 * Reimplements trAIcker's localOffsetMinutes so the plugin has zero
 * dependency on the trAIcker codebase.
 */
function localOffsetMinutes(): number {
  return -new Date().getTimezoneOffset();
}

/**
 * Resolve plugin config: explicit values win, then try trAIcker's config,
 * then hardcoded defaults.
 */
function resolveConfig(
  config: Config,
  ctx: CordisContext,
): { spoolDir: string | null; dbPath: string | null; excerptChars: number } {
  if (config.spoolDir) {
    return {
      spoolDir: config.spoolDir,
      dbPath: config.dbPath ?? null,
      excerptChars: config.promptExcerptChars ?? 80,
    };
  }

  // Try reading trAIcker's config.
  const configPath = resolve(homedir(), '.traicker', 'config.json');
  try {
    const raw = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    const spoolDir = (raw['spoolDir'] as string) ?? resolve(homedir(), '.traicker', 'spool');
    const dbPath = (raw['dbPath'] as string) ?? resolve(homedir(), '.traicker', 'time.db');
    const excerptChars =
      typeof raw['promptExcerptChars'] === 'number'
        ? Math.min(500, Math.max(0, Math.floor(raw['promptExcerptChars'])))
        : 80;
    return { spoolDir, dbPath, excerptChars };
  } catch {
    // Config not found or invalid.
    return { spoolDir: null, dbPath: null, excerptChars: 80 };
  }
}
/**
 * Shared types for the @traicker/dsh-plugin.
 *
 * Mirrors the subset of trAIcker types that the plugin needs, so the
 * package has zero dependency on the trAIcker codebase.
 *
 * @module @traicker/dsh-plugin/types
 */

/** Schema version of the spool record shape. Must match trAIcker's SpoolRecord v1. */
export const SPOOL_VERSION = 1 as const;

/** Event types trAIcker tracks. A subset — only the ones the DSH can produce. */
export type TrackedEvent =
  | 'SessionStart'
  | 'SessionEnd'
  | 'UserPromptSubmit'
  | 'Stop'
  | 'PostToolUse';

/**
 * One line of the NDJSON spool. Keys are deliberately terse to keep
 * concurrent O_APPEND writes atomic (~200-300 bytes per line).
 *
 * Strict subset of trAIcker's SpoolRecord (src/core/types.ts).
 */
export interface SpoolRecord {
  /** Schema version. Must be 1. */
  v: typeof SPOOL_VERSION;
  /** Event type. */
  e: TrackedEvent;
  /** ISO 8601 UTC with milliseconds. */
  t: string;
  /** Local UTC offset in minutes at capture time. */
  tz: number;
  /** Normalised absolute project path. */
  cwd: string;
  /** Session id. */
  sid: string;
  /** Agent id — null for the main loop, set for subagents. */
  aid: string | null;
  /** Agent type (subagent name), when applicable. */
  at: string | null;
  /** Prompt id, when the event is tied to a turn. */
  pid: string | null;
  /** Reason / source. */
  r: string | null;
  /** Auto-generated session title at capture time. */
  ttl: string | null;
  /** Length of the user prompt in characters (UserPromptSubmit only). */
  plen: number | null;
  /** Truncated prompt excerpt, only when session title is unavailable. */
  ex: string | null;
  /** Task id — always null for DSH (no TaskCreated events). */
  tid: null;
  /** Task subject — always null for DSH. */
  tsub: null;
  /** Tool duration in ms (PostToolUse only). */
  dur: number | null;
}

/** Token usage as reported by the DSH in `assistant/message.usage`. */
export interface TokenUsagePayload {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

/** DSH session header — available on every live session. */
export interface SessionHeaderData {
  id: string;
  cwd: string;
  createdAt: string;
  version: number;
  seedLength: number;
  parentSession?: string;
  delegationDepth?: number;
}

/** DSH hook/result event data. */
export interface HookResultData {
  turn: number;
  point: string;
  handlerId: string;
  decision: string;
  exitCode?: number;
  durationMs: number;
  matcher?: string;
}

/** DSH assistant/message event data. */
export interface AssistantMessageData {
  turn: number;
  step: number;
  message: Record<string, unknown>;
  usage?: TokenUsagePayload;
  interrupted?: true;
}

/** DSH user/message event data. */
export interface UserMessageData {
  content: unknown[];
  source: Record<string, unknown>;
  role: 'user';
  /** Present on injected context, absent on direct user prompts. */
  injected?: true;
}
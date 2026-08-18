/**
 * trAIcker hook entrypoint. One binary, all seven Claude Code events.
 *
 * This process runs inside your editing loop. Claude Code waits for it before
 * your prompt is delivered, so its entire job is: read stdin, append one line,
 * exit. Everything expensive — SQLite, project-root resolution, aggregation —
 * happens later, out of band.
 *
 * Four rules, all load-bearing:
 *
 * 1. NEVER write to stdout. On UserPromptSubmit, a hook's stdout is injected
 *    into your prompt as context. A stray log line would silently corrupt every
 *    message you send.
 *
 * 2. ALWAYS exit 0, whatever happens. A tracker that can block a session is
 *    worse than no tracker.
 *
 * 3. Keep the line small. `fs.appendFileSync` opens with O_APPEND, which makes
 *    seek-and-write a single atomic kernel operation — but only while the
 *    buffer fits in one write(). Parallel subagents in one session append to
 *    the same file concurrently, so an oversized line would let two writes
 *    interleave and destroy both. This is why the raw payload is never written:
 *    `prompt` and `last_assistant_message` are tens of kilobytes.
 *
 * 4. Import nothing heavy. Only node: builtins and two local modules that
 *    themselves import only node: builtins.
 */

import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadHookConfig } from './core/config.js';
import { normalizePath } from './core/paths.js';
import { isTrackedEvent, type SpoolRecord, type TrackedEvent } from './core/types.js';

/** Hard ceiling on the whole process, in case stdin never closes. */
const WATCHDOG_MS = 2_000;

/** Fail-safe cap on excerpt length regardless of config. */
const MAX_EXCERPT = 200;

function main(): void {
  const raw = readStdin();
  if (raw === null) return;

  let payload: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return;
    payload = parsed as Record<string, unknown>;
  } catch {
    return;
  }

  const eventType = payload['hook_event_name'];
  if (!isTrackedEvent(eventType)) return;

  // PostToolUse is registered with a Task matcher, but this guard makes the
  // filter belong to the code rather than to a settings file someone may edit.
  // Recording every tool call would be a lot of lines for no gain.
  if (eventType === 'PostToolUse' && payload['tool_name'] !== 'Task') return;

  const config = loadHookConfig();
  const record = buildRecord(eventType, payload, config.promptExcerptChars);
  if (record === null) return;

  // Deliberately NO filtering here. The hook records; ingestion decides what
  // counts. Filtering at capture time cost an hour of a client's work once:
  // `ignorePaths: ["C:/dev"]` meant to stop bare sessions in a workspace from
  // becoming a project, and a naive prefix match silently dropped every project
  // living inside it. Ingestion knows about declared projects and can be
  // re-run; a line never written is gone for good. An unwanted event costs
  // ~200 bytes and is filtered later.
  appendRecord(config.spoolDir, record);

  // A session ending is the natural moment to fold the spool into SQLite. Fired
  // detached so the exiting session never waits on it.
  if (eventType === 'SessionEnd') triggerBackgroundSync();
}

/**
 * Reads the hook payload from stdin.
 *
 * The synchronous read is the fast path and covers the normal case. Windows
 * pipes can surface EAGAIN on a not-yet-ready fd, so a bounded retry follows;
 * giving up quietly is preferable to blocking the session.
 */
function readStdin(): string | null {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const data = readFileSync(0, 'utf8');
      return data.length > 0 ? data : null;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EAGAIN') return null;
    }
  }
  return null;
}

function buildRecord(
  eventType: TrackedEvent,
  payload: Record<string, unknown>,
  excerptChars: number,
): SpoolRecord | null {
  // A session belongs to the project it was launched in, and CLAUDE_PROJECT_DIR
  // is the only field that says so.
  //
  // The live cwd is NOT a signal of ownership: an agent moves directories all
  // the time — reading a file from another repo, inspecting a sibling project —
  // and none of that changes whose work is being done. Trusting cwd instead
  // moved an hour of one client's work onto another's the first time a session
  // was asked to look at something next door. `new_cwd` is recorded for
  // auditing and deliberately not used for attribution, for the same reason.
  const cwdSource = process.env['CLAUDE_PROJECT_DIR'] ?? str(payload['cwd']) ?? process.cwd();

  let cwd: string;
  try {
    cwd = normalizePath(cwdSource);
  } catch {
    return null;
  }

  const sessionId = str(payload['session_id']);
  if (sessionId === null) return null;

  const now = new Date();
  const title = str(payload['session_title']);
  const prompt = eventType === 'UserPromptSubmit' ? str(payload['prompt']) : null;

  // The Task tool's input names the subagent; nothing else in the payload does,
  // and SubagentStop arrives with an empty agent_type.
  const toolInput = payload['tool_input'];
  const subagentType =
    eventType === 'PostToolUse' && typeof toolInput === 'object' && toolInput !== null
      ? str((toolInput as Record<string, unknown>)['subagent_type'])
      : null;
  const duration = eventType === 'PostToolUse' ? payload['duration_ms'] : null;

  return {
    v: 1,
    e: eventType,
    t: now.toISOString(),
    tz: -now.getTimezoneOffset(),
    cwd,
    sid: sessionId,
    aid: str(payload['agent_id']) ?? str(payload['tool_use_id']),
    at: str(payload['agent_type']) ?? subagentType,
    pid: str(payload['prompt_id']),
    r: str(payload['reason']) ?? str(payload['source']) ?? str(payload['old_cwd']),
    ttl: title === null ? null : clip(title, 120),
    plen: prompt === null ? null : prompt.length,
    // Only kept when Claude Code has not produced a title yet — on the first
    // prompt of a session there is nothing else to label the block with.
    ex: prompt !== null && title === null && excerptChars > 0 ? clip(prompt, Math.min(excerptChars, MAX_EXCERPT)) : null,
    tid: str(payload['task_id']),
    // Subject only. The description can run long, and line size is what keeps
    // concurrent appends atomic.
    tsub: (() => {
      const subject = str(payload['task_subject']);
      return subject === null ? null : clip(subject, 120);
    })(),
    dur: typeof duration === 'number' && Number.isFinite(duration) && duration >= 0 ? Math.round(duration) : null,
  };
}

/** Collapses whitespace and truncates. Keeps lines single-line and bounded. */
function clip(value: string, max: number): string | null {
  const flat = value.replace(/\s+/g, ' ').trim();
  if (flat.length === 0) return null;
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Appends the record to `<spool>/<local-day>/<session>.ndjson`.
 *
 * Sharding by session means two clients working simultaneously write to
 * different files — the concurrent-writer problem disappears rather than being
 * solved with locks. What remains is parallel subagents within one session,
 * which the small-line invariant above covers.
 */
function appendRecord(spoolDir: string, record: SpoolRecord): void {
  const day = new Date(Date.parse(record.t) + record.tz * 60_000).toISOString().slice(0, 10);
  const file = path.join(spoolDir, day, `${safeSegment(record.sid)}.ndjson`);
  const line = `${JSON.stringify(record)}\n`;

  try {
    appendFileSync(file, line, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return;
    // Directory missing: create it and retry once. Attempting the append first
    // keeps the common case down to a single syscall.
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      appendFileSync(file, line, 'utf8');
    } catch {
      /* dropped */
    }
  }
}

/** Strips anything that could escape the spool directory. */
function safeSegment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 100);
  return cleaned.length > 0 ? cleaned : 'unknown';
}

/**
 * Kicks off `traicker sync` fully detached, so the exiting session returns
 * immediately and the database is already fresh next time you look at it.
 */
function triggerBackgroundSync(): void {
  try {
    const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cli', 'index.js');
    const child = spawn(process.execPath, [cli, 'sync', '--quiet'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
  } catch {
    /* the lazy sync in the CLI and dashboard covers this */
  }
}

const watchdog = setTimeout(() => process.exit(0), WATCHDOG_MS);
watchdog.unref();

try {
  main();
} catch {
  /* never surface anything to the session */
}

process.exit(0);

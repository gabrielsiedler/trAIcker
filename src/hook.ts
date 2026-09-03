/**
 * trAIcker hook entrypoint. One binary for Claude Code and Cursor Agent/CLI.
 *
 * This process runs inside your editing loop. The host waits for it before
 * your prompt is delivered, so its entire job is: read stdin, append one line,
 * exit. Everything expensive — SQLite, project-root resolution, aggregation —
 * happens later, out of band.
 *
 * Four rules, all load-bearing:
 *
 * 1. NEVER write to stdout. On UserPromptSubmit / beforeSubmitPrompt, a hook's
 *    stdout is injected into your prompt as context (Claude) or parsed as a
 *    control response (Cursor). A stray log line would silently corrupt every
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

import { spawn, execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadHookConfig } from './core/config.js';
import { normalizePath } from './core/paths.js';
import { isTrackedEvent, type SpoolRecord, type ToolHost, type TrackedEvent } from './core/types.js';

/** Hard ceiling on the whole process, in case stdin never closes. */
const WATCHDOG_MS = 2_000;

/** Fail-safe cap on excerpt length regardless of config. */
const MAX_EXCERPT = 200;

/**
 * Cursor's native hook names → the Claude-shaped TrackedEvent names the spool
 * and aggregation pipeline already speak. Claude Code payloads pass through
 * unchanged (their hook_event_name is already a TrackedEvent).
 */
const CURSOR_EVENT_MAP: Record<string, TrackedEvent> = {
  sessionStart: 'SessionStart',
  sessionEnd: 'SessionEnd',
  beforeSubmitPrompt: 'UserPromptSubmit',
  subagentStart: 'SubagentStart',
  subagentStop: 'SubagentStop',
  stop: 'Stop',
  postToolUse: 'PostToolUse',
};

function main(): void {
  const raw = readPayload();
  if (raw === null) return;

  let payload: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return;
    payload = parsed as Record<string, unknown>;
  } catch {
    return;
  }

  const eventType = resolveEventType(payload['hook_event_name']);
  if (eventType === null) return;

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

function resolveEventType(raw: unknown): TrackedEvent | null {
  if (typeof raw !== 'string') return null;
  if (isTrackedEvent(raw)) return raw;
  return CURSOR_EVENT_MAP[raw] ?? null;
}

/**
 * Reads the hook payload.
 *
 * Claude Code and Cursor on Unix pass JSON on stdin. Cursor Agent on Windows
 * writes a temp cursor-hooks payload.json and runs Get-Content piped through
 * $input, which does not deliver bytes to Node's fd 0, and a blocking stdin
 * read would eat the whole 2s watchdog before we ever look at the temp file.
 * Prefer --payload, then the Windows Cursor temp-file path when CURSOR_VERSION
 * is set, then stdin.
 */
function readPayload(): string | null {
  const flag = process.argv.indexOf('--payload');
  if (flag >= 0) {
    const file = process.argv[flag + 1];
    if (typeof file === 'string' && file.length > 0) {
      try {
        const data = readFileSync(file, 'utf8');
        return data.length > 0 ? data : null;
      } catch {
        return null;
      }
    }
  }

  // Cursor Agent sets CURSOR_VERSION on the hook process. On Windows its
  // stdin transport is broken, so skip the blocking read entirely.
  if (process.platform === 'win32' && process.env['CURSOR_VERSION']) {
    return readWindowsCursorTempPayload();
  }

  const fromStdin = readStdin();
  if (fromStdin !== null) return fromStdin;

  if (process.platform === 'win32') return readWindowsCursorTempPayload();
  return null;
}

/**
 * Cursor Agent on Windows leaves the payload on disk under `%TEMP%\cursor-hooks-*`.
 * The path is also embedded in the parent PowerShell command line. Prefer that
 * exact path so concurrent hooks do not steal each other's files; fall back to
 * the newest fresh payload.json if the parent lookup fails.
 */
function readWindowsCursorTempPayload(): string | null {
  if (process.platform !== 'win32') return null;

  const fromParent = payloadPathFromParentCommandLine();
  if (fromParent !== null) {
    try {
      const data = readFileSync(fromParent, 'utf8');
      return data.length > 0 ? data : null;
    } catch {
      /* fall through */
    }
  }

  try {
    const root = tmpdir();
    const fresh: Array<{ file: string; mtime: number }> = [];
    const cutoff = Date.now() - 15_000;

    for (const name of readdirSync(root)) {
      if (!name.startsWith('cursor-hooks-')) continue;
      const file = path.join(root, name, 'payload.json');
      try {
        const st = statSync(file);
        if (st.isFile() && st.mtimeMs >= cutoff) fresh.push({ file, mtime: st.mtimeMs });
      } catch {
        /* missing */
      }
    }

    fresh.sort((a, b) => b.mtime - a.mtime);
    const best = fresh[0];
    if (!best) return null;
    const data = readFileSync(best.file, 'utf8');
    return data.length > 0 ? data : null;
  } catch {
    return null;
  }
}

/** Pulls `...\cursor-hooks-...\payload.json` out of the parent process command line. */
function payloadPathFromParentCommandLine(): string | null {
  try {
    const ppid = process.ppid;
    if (!ppid || ppid <= 0) return null;
    const out = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${ppid}").CommandLine`,
      ],
      { encoding: 'utf8', timeout: 800, windowsHide: true },
    );
    const match = out.match(/([A-Za-z]:\\[^'"\r\n]*cursor-hooks-[^'"\r\n\\]+\\payload\.json)/i);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
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
  // A session belongs to the project it was launched in.
  //
  // Claude Code exposes that as CLAUDE_PROJECT_DIR. Cursor exposes it as
  // workspace_roots[0]. The live cwd is NOT a signal of ownership: an agent
  // moves directories all the time — reading a file from another repo,
  // inspecting a sibling project — and none of that changes whose work is
  // being done. Trusting cwd instead moved an hour of one client's work onto
  // another's the first time a session was asked to look at something next
  // door. `new_cwd` is recorded for auditing and deliberately not used for
  // attribution, for the same reason.
  const roots = payload['workspace_roots'];
  const workspaceRoot =
    Array.isArray(roots) && typeof roots[0] === 'string' && roots[0].length > 0 ? roots[0] : null;

  // Empty string is what the doctor/tests use to clear the Claude env var on
  // hosts that set it; treat it as absent so Cursor's workspace_roots win.
  const claudeProject = str(process.env['CLAUDE_PROJECT_DIR']);

  const cwdSource = claudeProject ?? workspaceRoot ?? str(payload['cwd']) ?? process.cwd();

  let cwd: string;
  try {
    cwd = normalizePath(cwdSource);
  } catch {
    return null;
  }

  // Claude uses session_id; Cursor's common schema uses conversation_id
  // (sessionStart/sessionEnd also mirror it as session_id).
  const sessionId =
    str(payload['session_id']) ?? str(payload['conversation_id']) ?? str(payload['parent_conversation_id']);
  if (sessionId === null) return null;

  const now = new Date();
  const title = str(payload['session_title']);
  const prompt = eventType === 'UserPromptSubmit' ? str(payload['prompt']) : null;

  // The Task tool's input names the subagent; nothing else in the Claude
  // payload does, and SubagentStop arrives with an empty agent_type. Cursor
  // puts subagent_type on the lifecycle events themselves.
  const toolInput = payload['tool_input'];
  const toolSubagentType =
    eventType === 'PostToolUse' && typeof toolInput === 'object' && toolInput !== null
      ? str((toolInput as Record<string, unknown>)['subagent_type'])
      : null;

  // Cursor postToolUse reports `duration`; Claude and Cursor subagentStop use
  // `duration_ms`. Accept both so a single binary covers both hosts.
  const duration =
    eventType === 'PostToolUse' || eventType === 'SubagentStop'
      ? num(payload['duration_ms']) ?? num(payload['duration'])
      : null;

  // Cursor's stop carries model + token totals for the turn. Claude Code never
  // puts either on the hook — those come from the transcript later. Keep the
  // assistant text out: it can be megabytes and would break the line-size
  // invariant that keeps concurrent appends atomic.
  const usage = eventType === 'Stop' ? cursorUsage(payload) : null;

  return {
    v: 1,
    e: eventType,
    t: now.toISOString(),
    tz: -now.getTimezoneOffset(),
    cwd,
    sid: sessionId,
    aid:
      str(payload['subagent_id']) ??
      str(payload['agent_id']) ??
      str(payload['tool_use_id']) ??
      str(payload['tool_call_id']),
    at: str(payload['agent_type']) ?? str(payload['subagent_type']) ?? toolSubagentType,
    pid: str(payload['prompt_id']) ?? str(payload['generation_id']),
    r: str(payload['reason']) ?? str(payload['source']) ?? str(payload['status']) ?? str(payload['old_cwd']),
    ttl: title === null ? null : clip(title, 120),
    plen: prompt === null ? null : prompt.length,
    // Only kept when the host has not produced a title yet — on the first
    // prompt of a session there is nothing else to label the block with.
    ex: prompt !== null && title === null && excerptChars > 0 ? clip(prompt, Math.min(excerptChars, MAX_EXCERPT)) : null,
    tid: str(payload['task_id']),
    // Subject only. The description can run long, and line size is what keeps
    // concurrent appends atomic.
    tsub: (() => {
      const subject = str(payload['task_subject']) ?? str(payload['description']) ?? str(payload['task']);
      return subject === null ? null : clip(subject, 120);
    })(),
    dur: duration,
    h: detectHost(payload),
    ...(usage ?? {}),
  };
}

/**
 * Pulls model + token totals off a Cursor stop payload.
 *
 * Returns null when the host did not report a usable pair (Claude Code, or an
 * older Cursor build that omits tokens). Partial numbers are dropped rather
 * than stored as zeros — a missing count is not the same as a free turn.
 */
function cursorUsage(
  payload: Record<string, unknown>,
): Pick<SpoolRecord, 'm' | 'ti' | 'to' | 'tcw' | 'tcr'> | null {
  const model = cursorModelName(payload);
  const input = num(payload['input_tokens']);
  const output = num(payload['output_tokens']);
  if (model === null || input === null || output === null) return null;

  return {
    m: model,
    ti: input,
    to: output,
    tcw: num(payload['cache_write_tokens']) ?? 0,
    tcr: num(payload['cache_read_tokens']) ?? 0,
  };
}

/**
 * Cursor's hook schema exposes both a legacy `model` slug and an optional
 * structured `model_id`. Auto mode reports the legacy value as `"default"`
 * (display name "Auto" in the UI) and never says which backend model ran —
 * that routing stays inside Cursor. Prefer `model_id` when present, and map
 * the Auto placeholder to `auto` so the Models tab matches the picker label.
 */
function cursorModelName(payload: Record<string, unknown>): string | null {
  const raw = str(payload['model_id']) ?? str(payload['model']);
  if (raw === null) return null;
  return raw === 'default' ? 'auto' : raw;
}

/** Cursor payloads use camelCase hook names or conversation_id; Claude uses TrackedEvent names. */
function detectHost(payload: Record<string, unknown>): ToolHost {
  const raw = payload['hook_event_name'];
  if (typeof raw === 'string' && !isTrackedEvent(raw)) return 'cursor';
  if (str(payload['conversation_id']) !== null) return 'cursor';
  const roots = payload['workspace_roots'];
  if (Array.isArray(roots) && roots.length > 0) return 'cursor';
  if (process.env['CURSOR_VERSION']) return 'cursor';
  return 'claude';
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

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
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

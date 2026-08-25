import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { hookCommand, hookScriptPath } from './hook-command.js';

/**
 * Per-hook timeout in seconds.
 *
 * Same bound as Claude Code hooks: Cursor's default is generous, and a hung
 * hook would stall the agent loop. Five seconds caps the worst case; the hook
 * itself self-terminates after two.
 */
const HOOK_TIMEOUT_SECONDS = 5;

/** Marks entries as ours so reinstall replaces rather than duplicates them. */
const MARKER = 'traicker/dist/hook.js';

/**
 * Cursor agent / CLI hook events trAIcker subscribes to.
 *
 * Names are camelCase (Cursor's native format). The shared hook binary maps
 * them onto the Claude-shaped TrackedEvent names the spool already uses.
 *
 * `postToolUse` is matched to `Task` only: every other tool call is noise on
 * the critical path. Cursor's `subagentStop` also carries `duration_ms`, so it
 * covers the case where Start/Stop pairing is incomplete.
 */
export const CURSOR_TRACKED_EVENTS = [
  'sessionStart',
  'sessionEnd',
  'beforeSubmitPrompt',
  'subagentStart',
  'subagentStop',
  'stop',
  'postToolUse',
] as const;

export type CursorTrackedEvent = (typeof CURSOR_TRACKED_EVENTS)[number];

interface CursorHookEntry {
  command: string;
  timeout?: number;
  matcher?: string;
}

export interface CursorInstallPlan {
  settingsPath: string;
  hookScript: string;
  before: string;
  after: string;
  added: CursorTrackedEvent[];
  replaced: CursorTrackedEvent[];
  unchanged: CursorTrackedEvent[];
}

export function cursorHooksPath(scope: 'user' | 'project', projectDir?: string): string {
  return scope === 'user'
    ? path.join(homedir(), '.cursor', 'hooks.json')
    : path.join(projectDir ?? process.cwd(), '.cursor', 'hooks.json');
}

export { hookCommand, hookScriptPath } from './hook-command.js';

const MATCHERS: Partial<Record<CursorTrackedEvent, string>> = {
  postToolUse: 'Task',
};

function hookEntry(hookScript: string, event: CursorTrackedEvent): CursorHookEntry {
  const matcher = MATCHERS[event];
  return {
    command: hookCommand(hookScript),
    timeout: HOOK_TIMEOUT_SECONDS,
    ...(matcher ? { matcher } : {}),
  };
}

function isOurs(entry: unknown): boolean {
  if (typeof entry !== 'object' || entry === null) return false;
  const command = (entry as CursorHookEntry).command;
  return typeof command === 'string' && command.includes(MARKER);
}

/**
 * Computes the hooks.json change without applying it.
 *
 * Existing hooks for the same events are preserved — only trAIcker's own entry
 * is added or refreshed.
 */
export function planCursorInstall(target: string, hookScript: string): CursorInstallPlan {
  let settings: Record<string, unknown> = { version: 1 };
  let before = '';

  if (existsSync(target)) {
    before = readFileSync(target, 'utf8');
    try {
      const parsed: unknown = JSON.parse(before);
      if (typeof parsed === 'object' && parsed !== null) settings = parsed as Record<string, unknown>;
    } catch (error) {
      throw new Error(`${target} is not valid JSON, refusing to overwrite it: ${String(error)}`);
    }
  }

  if (typeof settings['version'] !== 'number') settings['version'] = 1;

  const hooks: Record<string, unknown> =
    typeof settings['hooks'] === 'object' && settings['hooks'] !== null
      ? { ...(settings['hooks'] as Record<string, unknown>) }
      : {};

  const added: CursorTrackedEvent[] = [];
  const replaced: CursorTrackedEvent[] = [];
  const unchanged: CursorTrackedEvent[] = [];

  for (const event of CURSOR_TRACKED_EVENTS) {
    const entry = hookEntry(hookScript, event);
    const existing = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
    const mine = existing.filter(isOurs);
    const theirs = existing.filter((m) => !isOurs(m));

    if (mine.length === 1 && JSON.stringify(mine[0]) === JSON.stringify(entry)) {
      unchanged.push(event);
      hooks[event] = existing;
      continue;
    }

    if (mine.length > 0) replaced.push(event);
    else added.push(event);

    hooks[event] = [...theirs, entry];
  }

  settings['hooks'] = hooks;
  const after = `${JSON.stringify(settings, null, 2)}\n`;

  return { settingsPath: target, hookScript, before, after, added, replaced, unchanged };
}

/** Writes the plan, taking a timestamped backup of the previous file first. */
export function applyCursorInstall(plan: CursorInstallPlan): string | null {
  mkdirSync(path.dirname(plan.settingsPath), { recursive: true });

  let backup: string | null = null;
  if (existsSync(plan.settingsPath)) {
    backup = `${plan.settingsPath}.traicker-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    copyFileSync(plan.settingsPath, backup);
  }

  writeFileSync(plan.settingsPath, plan.after, 'utf8');
  return backup;
}

/** Removes only trAIcker's entries, leaving every other hook in place. */
export function planCursorUninstall(target: string): CursorInstallPlan {
  const before = existsSync(target) ? readFileSync(target, 'utf8') : '{"version":1}\n';
  let settings: Record<string, unknown>;
  try {
    settings = JSON.parse(before) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`${target} is not valid JSON, refusing to overwrite it: ${String(error)}`);
  }

  const hooks: Record<string, unknown> =
    typeof settings['hooks'] === 'object' && settings['hooks'] !== null
      ? { ...(settings['hooks'] as Record<string, unknown>) }
      : {};

  const removed: CursorTrackedEvent[] = [];

  for (const event of CURSOR_TRACKED_EVENTS) {
    if (!Array.isArray(hooks[event])) continue;
    const kept = (hooks[event] as unknown[]).filter((m) => !isOurs(m));
    if (kept.length !== (hooks[event] as unknown[]).length) removed.push(event);
    if (kept.length === 0) delete hooks[event];
    else hooks[event] = kept;
  }

  if (Object.keys(hooks).length === 0) delete settings['hooks'];
  else settings['hooks'] = hooks;

  return {
    settingsPath: target,
    hookScript: '',
    before,
    after: `${JSON.stringify(settings, null, 2)}\n`,
    added: [],
    replaced: removed,
    unchanged: [],
  };
}

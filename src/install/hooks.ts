import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { TRACKED_EVENTS, type TrackedEvent } from '../core/types.js';

/**
 * Per-hook timeout in seconds.
 *
 * Claude Code's default is 600s — a hung hook would stall a session for ten
 * minutes. Five seconds bounds the worst case to something survivable; the hook
 * itself self-terminates after two.
 */
const HOOK_TIMEOUT_SECONDS = 5;

/** Marks entries as ours so reinstall replaces rather than duplicates them. */
const MARKER = 'traicker/dist/hook.js';

interface HookCommand {
  type: 'command';
  command: string;
  timeout?: number;
}

interface HookMatcher {
  matcher?: string;
  hooks: HookCommand[];
}

export interface InstallPlan {
  settingsPath: string;
  hookScript: string;
  before: string;
  after: string;
  added: TrackedEvent[];
  replaced: TrackedEvent[];
  unchanged: TrackedEvent[];
}

export function settingsPath(scope: 'user' | 'project', projectDir?: string): string {
  return scope === 'user'
    ? path.join(homedir(), '.claude', 'settings.json')
    : path.join(projectDir ?? process.cwd(), '.claude', 'settings.json');
}

/** Absolute path to the compiled hook, in the forward-slash form settings want. */
export function hookScriptPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // src/install/hooks.ts -> dist/install/hooks.js, so the hook is one level up.
  return path.resolve(here, '..', 'hook.js').replace(/\\/g, '/');
}

/**
 * Events that must be narrowed by a matcher.
 *
 * PostToolUse fires on every tool call — hundreds per session, each a process
 * spawn on the critical path. Matching `Task` keeps it to subagent runs, which
 * are the only ones worth a line.
 */
const MATCHERS: Partial<Record<TrackedEvent, string>> = {
  PostToolUse: 'Task',
};

function hookEntry(hookScript: string, event: TrackedEvent): HookMatcher {
  const matcher = MATCHERS[event];
  return {
    ...(matcher ? { matcher } : {}),
    hooks: [
      {
        type: 'command',
        // Forward slashes and an absolute node path work identically under
        // cmd.exe, PowerShell and Git Bash, which is what Claude Code may use.
        command: `node "${hookScript}"`,
        timeout: HOOK_TIMEOUT_SECONDS,
      },
    ],
  };
}

function isOurs(matcher: unknown): boolean {
  if (typeof matcher !== 'object' || matcher === null) return false;
  const hooks = (matcher as HookMatcher).hooks;
  return Array.isArray(hooks) && hooks.some((h) => typeof h?.command === 'string' && h.command.includes(MARKER));
}

/**
 * Computes the settings change without applying it.
 *
 * Existing hooks for the same events are preserved — only trAIcker's own entry
 * is added or refreshed. Your `rtk hook claude` on PreToolUse is untouched.
 */
export function planInstall(target: string, hookScript: string): InstallPlan {
  let settings: Record<string, unknown> = {};
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

  const hooks: Record<string, unknown> =
    typeof settings['hooks'] === 'object' && settings['hooks'] !== null
      ? { ...(settings['hooks'] as Record<string, unknown>) }
      : {};

  const added: TrackedEvent[] = [];
  const replaced: TrackedEvent[] = [];
  const unchanged: TrackedEvent[] = [];

  for (const event of TRACKED_EVENTS) {
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
export function applyInstall(plan: InstallPlan): string | null {
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
export function planUninstall(target: string): InstallPlan {
  const before = existsSync(target) ? readFileSync(target, 'utf8') : '{}';
  const settings = JSON.parse(before) as Record<string, unknown>;

  const hooks: Record<string, unknown> =
    typeof settings['hooks'] === 'object' && settings['hooks'] !== null
      ? { ...(settings['hooks'] as Record<string, unknown>) }
      : {};

  const removed: TrackedEvent[] = [];

  for (const event of TRACKED_EVENTS) {
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

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  applyCursorInstall,
  CURSOR_TRACKED_EVENTS,
  planCursorInstall,
  planCursorUninstall,
} from '../src/install/cursor-hooks.js';

let dir: string;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('cursor hooks install', () => {
  it('writes versioned hooks.json with every tracked event', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'traicker-cursor-'));
    const target = path.join(dir, 'hooks.json');
    const hookScript = 'C:/dev/traicker/dist/hook.js';

    const plan = planCursorInstall(target, hookScript);
    expect(plan.added).toEqual([...CURSOR_TRACKED_EVENTS]);
    expect(plan.replaced).toEqual([]);

    applyCursorInstall(plan);

    const written = JSON.parse(readFileSync(target, 'utf8')) as {
      version: number;
      hooks: Record<string, Array<{ command: string; matcher?: string; timeout?: number }>>;
    };
    expect(written.version).toBe(1);
    for (const event of CURSOR_TRACKED_EVENTS) {
      expect(written.hooks[event]?.some((h) => h.command.includes('traicker/dist/hook.js'))).toBe(true);
    }
    expect(written.hooks['postToolUse']![0]!.matcher).toBe('Task');
  });

  it('preserves foreign hooks on the same events', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'traicker-cursor-'));
    const target = path.join(dir, 'hooks.json');
    writeFileSync(
      target,
      JSON.stringify({
        version: 1,
        hooks: {
          beforeSubmitPrompt: [{ command: './audit.sh' }],
        },
      }),
      'utf8',
    );

    const plan = planCursorInstall(target, 'C:/dev/traicker/dist/hook.js');
    applyCursorInstall(plan);

    const written = JSON.parse(readFileSync(target, 'utf8')) as {
      hooks: Record<string, Array<{ command: string }>>;
    };
    const prompts = written.hooks['beforeSubmitPrompt']!;
    expect(prompts).toHaveLength(2);
    expect(prompts[0]!.command).toBe('./audit.sh');
    expect(prompts[1]!.command).toContain('traicker/dist/hook.js');
  });

  it('uninstall strips only trAIcker entries', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'traicker-cursor-'));
    const target = path.join(dir, 'hooks.json');
    applyCursorInstall(planCursorInstall(target, 'C:/dev/traicker/dist/hook.js'));

    // Inject a foreign hook after install.
    const current = JSON.parse(readFileSync(target, 'utf8')) as {
      version: number;
      hooks: Record<string, Array<{ command: string }>>;
    };
    current.hooks['stop'] = [...(current.hooks['stop'] ?? []), { command: './other.sh' }];
    writeFileSync(target, JSON.stringify(current), 'utf8');

    const plan = planCursorUninstall(target);
    applyCursorInstall(plan);

    const written = JSON.parse(readFileSync(target, 'utf8')) as {
      hooks?: Record<string, Array<{ command: string }>>;
    };
    expect(written.hooks?.['sessionStart']).toBeUndefined();
    expect(written.hooks?.['stop']).toEqual([{ command: './other.sh' }]);
    expect(existsSync(target)).toBe(true);
  });
});

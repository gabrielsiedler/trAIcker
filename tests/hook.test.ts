import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * The hook runs as a separate process against the compiled binary, so these
 * exercise the real thing rather than the module. Skipped when dist is absent.
 */
const HOOK = path.resolve('dist/hook.js');
const BUILT = existsSync(HOOK);

let dataDir: string;
let projectDir: string;

function runHook(payload: Record<string, unknown>) {
  return spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, TRAICKER_DATA_DIR: dataDir, CLAUDE_PROJECT_DIR: '' },
    timeout: 10_000,
  });
}

function spoolLines(): string[] {
  const spool = path.join(dataDir, 'spool');
  if (!existsSync(spool)) return [];

  const lines: string[] = [];
  for (const day of readdirSync(spool)) {
    const dir = path.join(spool, day);
    try {
      for (const file of readdirSync(dir)) {
        if (!file.endsWith('.ndjson')) continue;
        lines.push(...readFileSync(path.join(dir, file), 'utf8').split('\n').filter(Boolean));
      }
    } catch {
      /* not a directory */
    }
  }
  return lines;
}

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'traicker-hook-'));
  projectDir = mkdtempSync(path.join(tmpdir(), 'traicker-proj-'));
  mkdirSync(path.join(projectDir, '.git'), { recursive: true });
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

describe.skipIf(!BUILT)('hook binary', () => {
  it('records an event', () => {
    const result = runHook({
      session_id: 's1',
      cwd: projectDir.replace(/\\/g, '/'),
      hook_event_name: 'UserPromptSubmit',
      prompt: 'hello',
      prompt_id: 'p1',
    });

    expect(result.status).toBe(0);
    expect(spoolLines()).toHaveLength(1);
  });

  it('records even when the path sits under an ignored prefix', () => {
    // Regression. `ignorePaths: ["C:/dev"]` was meant to stop bare sessions in
    // a workspace becoming a project; a prefix match in the hook silently
    // dropped every project living inside it, and an hour of a client's work
    // was lost before anyone noticed. Filtering belongs to ingestion, which can
    // be re-run — a line the hook never wrote is gone for good.
    writeFileSync(
      path.join(dataDir, 'config.json'),
      JSON.stringify({ ignorePaths: [path.dirname(projectDir).replace(/\\/g, '/')] }),
      'utf8',
    );

    const result = runHook({
      session_id: 's1',
      cwd: projectDir.replace(/\\/g, '/'),
      hook_event_name: 'UserPromptSubmit',
      prompt: 'hello',
      prompt_id: 'p1',
    });

    expect(result.status).toBe(0);
    expect(spoolLines()).toHaveLength(1);
  });

  it('keeps a session on its launch project when an agent looks elsewhere', () => {
    // Regression, and a lesson learnt the expensive way. Asking a session to
    // read context from a sibling repo moves the cwd; it does not change whose
    // work is being done. Trusting the live cwd moved an hour of one client's
    // time onto another's.
    const elsewhere = mkdtempSync(path.join(tmpdir(), 'traicker-elsewhere-'));
    mkdirSync(path.join(elsewhere, '.git'), { recursive: true });

    const result = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({
        session_id: 's1',
        cwd: elsewhere.replace(/\\/g, '/'),
        hook_event_name: 'UserPromptSubmit',
        prompt: 'read the notes next door',
        prompt_id: 'p1',
      }),
      encoding: 'utf8',
      env: { ...process.env, TRAICKER_DATA_DIR: dataDir, CLAUDE_PROJECT_DIR: projectDir },
      timeout: 10_000,
    });

    expect(result.status).toBe(0);
    const record = JSON.parse(spoolLines()[0]!) as { cwd: string };
    expect(record.cwd.toLowerCase()).toContain(path.basename(projectDir).toLowerCase());
    expect(record.cwd.toLowerCase()).not.toContain(path.basename(elsewhere).toLowerCase());

    rmSync(elsewhere, { recursive: true, force: true });
  });

  it('does not let a directory change reassign the session', () => {
    const destination = mkdtempSync(path.join(tmpdir(), 'traicker-dest-'));

    const result = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({
        session_id: 's1',
        cwd: projectDir.replace(/\\/g, '/'),
        hook_event_name: 'CwdChanged',
        old_cwd: projectDir.replace(/\\/g, '/'),
        new_cwd: destination.replace(/\\/g, '/'),
      }),
      encoding: 'utf8',
      env: { ...process.env, TRAICKER_DATA_DIR: dataDir, CLAUDE_PROJECT_DIR: projectDir },
      timeout: 10_000,
    });

    expect(result.status).toBe(0);
    const record = JSON.parse(spoolLines()[0]!) as { cwd: string; r: string | null };
    // Attributed to the session's project; the destination survives only as
    // an audit trail in the reason field.
    expect(record.cwd.toLowerCase()).toContain(path.basename(projectDir).toLowerCase());

    rmSync(destination, { recursive: true, force: true });
  });

  it('never writes to stdout, which would be injected into the prompt', () => {
    const result = runHook({
      session_id: 's1',
      cwd: projectDir.replace(/\\/g, '/'),
      hook_event_name: 'UserPromptSubmit',
      prompt: 'hello',
      prompt_id: 'p1',
    });

    expect(result.stdout).toBe('');
  });

  it('exits cleanly on malformed input rather than blocking the session', () => {
    const result = spawnSync(process.execPath, [HOOK], {
      input: 'not json',
      encoding: 'utf8',
      env: { ...process.env, TRAICKER_DATA_DIR: dataDir },
      timeout: 10_000,
    });

    expect(result.status).toBe(0);
    expect(spoolLines()).toHaveLength(0);
  });

  it('survives a broken config file', () => {
    writeFileSync(path.join(dataDir, 'config.json'), '{ this is not json', 'utf8');

    const result = runHook({
      session_id: 's1',
      cwd: projectDir.replace(/\\/g, '/'),
      hook_event_name: 'SessionStart',
      source: 'startup',
    });

    expect(result.status).toBe(0);
    expect(spoolLines()).toHaveLength(1);
  });

  it('ignores events it does not track', () => {
    const result = runHook({ session_id: 's1', cwd: projectDir, hook_event_name: 'PreToolUse', tool_name: 'Bash' });

    expect(result.status).toBe(0);
    expect(spoolLines()).toHaveLength(0);
  });

  it('keeps free-form text out of the spool', () => {
    runHook({
      session_id: 's1',
      cwd: projectDir.replace(/\\/g, '/'),
      hook_event_name: 'Stop',
      last_assistant_message: 'SECRET_CLIENT_DETAIL '.repeat(200),
    });

    const lines = spoolLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('SECRET_CLIENT_DETAIL');
    // Small enough that concurrent appends stay atomic.
    expect(lines[0]!.length).toBeLessThan(600);
  });

  it('maps Cursor beforeSubmitPrompt onto UserPromptSubmit', () => {
    const result = runHook({
      conversation_id: 'conv-1',
      generation_id: 'gen-1',
      hook_event_name: 'beforeSubmitPrompt',
      workspace_roots: [projectDir.replace(/\\/g, '/')],
      prompt: 'fix the auth flow',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    const lines = spoolLines();
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]!) as {
      e: string;
      sid: string;
      pid: string;
      plen: number;
      cwd: string;
      h: string;
    };
    expect(record.e).toBe('UserPromptSubmit');
    expect(record.sid).toBe('conv-1');
    expect(record.pid).toBe('gen-1');
    expect(record.plen).toBe('fix the auth flow'.length);
    expect(record.cwd.toLowerCase()).toContain(path.basename(projectDir).toLowerCase());
    expect(record.h).toBe('cursor');
  });

  it('maps Cursor subagentStop duration onto the spool', () => {
    runHook({
      conversation_id: 'conv-2',
      hook_event_name: 'subagentStop',
      workspace_roots: [projectDir.replace(/\\/g, '/')],
      subagent_id: 'sa-9',
      subagent_type: 'explore',
      duration_ms: 45_000,
      status: 'completed',
    });

    const record = JSON.parse(spoolLines()[0]!) as {
      e: string;
      aid: string;
      at: string;
      dur: number;
      r: string;
    };
    expect(record.e).toBe('SubagentStop');
    expect(record.aid).toBe('sa-9');
    expect(record.at).toBe('explore');
    expect(record.dur).toBe(45_000);
    expect(record.r).toBe('completed');
  });

  it('maps Cursor postToolUse duration field onto PostToolUse', () => {
    runHook({
      conversation_id: 'conv-3',
      hook_event_name: 'postToolUse',
      workspace_roots: [projectDir.replace(/\\/g, '/')],
      tool_name: 'Task',
      tool_use_id: 'tu-1',
      tool_input: { subagent_type: 'generalPurpose' },
      duration: 12_000,
    });

    const record = JSON.parse(spoolLines()[0]!) as {
      e: string;
      aid: string;
      at: string;
      dur: number;
    };
    expect(record.e).toBe('PostToolUse');
    expect(record.aid).toBe('tu-1');
    expect(record.at).toBe('generalPurpose');
    expect(record.dur).toBe(12_000);
  });

  it('reads --payload file used by the Windows Cursor wrapper', () => {
    const payloadFile = path.join(dataDir, 'payload.json');
    writeFileSync(
      payloadFile,
      JSON.stringify({
        conversation_id: 'conv-payload',
        hook_event_name: 'beforeSubmitPrompt',
        workspace_roots: [projectDir.replace(/\\/g, '/')],
        prompt: 'from temp file',
      }),
      'utf8',
    );

    const result = spawnSync(process.execPath, [HOOK, '--payload', payloadFile], {
      encoding: 'utf8',
      env: { ...process.env, TRAICKER_DATA_DIR: dataDir, CLAUDE_PROJECT_DIR: '' },
      timeout: 10_000,
    });

    expect(result.status).toBe(0);
    const record = JSON.parse(spoolLines()[0]!) as { e: string; sid: string; plen: number };
    expect(record.e).toBe('UserPromptSubmit');
    expect(record.sid).toBe('conv-payload');
    expect(record.plen).toBe('from temp file'.length);
  });

  it('attributes Cursor sessions to workspace_roots, not live cwd', () => {
    const elsewhere = mkdtempSync(path.join(tmpdir(), 'traicker-elsewhere-'));
    mkdirSync(path.join(elsewhere, '.git'), { recursive: true });

    const result = runHook({
      conversation_id: 'conv-4',
      hook_event_name: 'beforeSubmitPrompt',
      cwd: elsewhere.replace(/\\/g, '/'),
      workspace_roots: [projectDir.replace(/\\/g, '/')],
      prompt: 'look next door',
    });

    expect(result.status).toBe(0);
    const record = JSON.parse(spoolLines()[0]!) as { cwd: string };
    expect(record.cwd.toLowerCase()).toContain(path.basename(projectDir).toLowerCase());
    expect(record.cwd.toLowerCase()).not.toContain(path.basename(elsewhere).toLowerCase());

    rmSync(elsewhere, { recursive: true, force: true });
  });
});

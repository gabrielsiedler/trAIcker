import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The transcript walk is rooted at `homedir()/.claude/projects`, so the fake
// tree has to be the home directory as far as the module under test is
// concerned. Hoisted because vi.mock is lifted above the imports.
const home = vi.hoisted(() => ({ dir: '' }));
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => home.dir };
});

import type { TraickerConfig } from '../src/core/config.js';
import { openDb, upsertProject, type Db } from '../src/core/db.js';
import { captureModelUsage } from '../src/ingest/usage.js';

const SESSION = 'sess-1';
const AGENT = 'a1b2c3';
const SLUG = 'C--work-acme';

let root: string;
let projectDir: string;
let db: Db;
let cfg: TraickerConfig;

function makeConfig(dataDir: string): TraickerConfig {
  return {
    dataDir,
    dbPath: path.join(dataDir, 'time.db'),
    spoolDir: path.join(dataDir, 'spool'),
    idleTimeoutMinutes: 15,
    idleAttributionCapMinutes: 120,
    maxTurnMinutes: 120,
    maxSubagentMinutes: 120,
    promptExcerptChars: 80,
    stitchGapMinutes: 10,
    spoolRetentionDays: 7,
    spoolRetentionAction: 'keep',
    ignorePaths: [],
    projects: {},
    modelPricing: {},
    serverPort: 4317,
    translationModel: 'claude-opus-5',
    llmBaseUrl: 'https://openrouter.ai/api/v1',
  };
}

/**
 * One `type: "assistant"` transcript line, shaped as Claude Code writes it.
 *
 * `pad` inflates the line without changing what it means — the cursor test
 * needs control over byte lengths, which is what a real transcript varies by
 * (a turn carrying a large tool result is megabytes).
 */
function turn(messageId: string, model: string, tokens: number, sidechain = false, pad = ''): string {
  return `${JSON.stringify({
    type: 'assistant',
    cwd: projectDir,
    sessionId: SESSION,
    isSidechain: sidechain,
    timestamp: '2026-08-10T12:00:00.000Z',
    padding: pad,
    message: {
      id: messageId,
      model,
      usage: {
        input_tokens: tokens,
        output_tokens: tokens,
        cache_creation_input_tokens: tokens,
        cache_read_input_tokens: tokens,
      },
    },
  })}\n`;
}

/** The session's own transcript: `<slug>/<session-id>.jsonl`. */
function writeSessionTranscript(lines: string): void {
  const dir = path.join(root, '.claude', 'projects', SLUG);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${SESSION}.jsonl`), lines, 'utf8');
}

/** A subagent's own transcript, one level deeper. */
function writeSubagentTranscript(agentId: string, lines: string): void {
  const dir = path.join(root, '.claude', 'projects', SLUG, SESSION, 'subagents');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `agent-${agentId}.jsonl`), lines, 'utf8');
}

/** Minimal event, just enough for the session to count as one trAIcker tracks. */
function seedEvent(sessionId: string, projectId: number): void {
  db.prepare(
    `INSERT INTO events (
       event_uid, event_type, ts_utc, tz_offset_min, project_id, session_id, payload_json, ingested_at
     ) VALUES (?, 'UserPromptSubmit', '2026-08-10T12:00:00.000Z', -180, ?, ?, '{}', '2026-08-10T12:00:00.000Z')`,
  ).run(`uid-${sessionId}`, projectId, sessionId);
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'traicker-usage-'));
  home.dir = root;
  projectDir = path.join(root, 'acme');
  mkdirSync(projectDir, { recursive: true });
  cfg = makeConfig(root);
  db = openDb(cfg);
  const projectId = upsertProject(db, projectDir, {}).id;
  seedEvent(SESSION, projectId);
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

function capturedTokens(): number {
  const row = db.prepare('SELECT COALESCE(SUM(output_tokens), 0) AS n FROM model_usage').get() as { n: number };
  return row.n;
}

describe('captureModelUsage', () => {
  it('captures turns from the session transcript', () => {
    writeSessionTranscript(turn('msg_main', 'claude-opus-5', 100));

    const result = captureModelUsage(db, cfg);

    expect(result.turnsInserted).toBe(1);
    expect(capturedTokens()).toBe(100);
  });

  it('captures subagent turns, which live in their own file one level deeper', () => {
    writeSessionTranscript(turn('msg_main', 'claude-opus-5', 100));
    writeSubagentTranscript(AGENT, turn('msg_sub', 'claude-sonnet-5', 7, true));

    captureModelUsage(db, cfg);

    const rows = db.prepare('SELECT model, output_tokens FROM model_usage ORDER BY model').all() as Array<{
      model: string;
      output_tokens: number;
    }>;
    expect(rows).toEqual([
      { model: 'claude-opus-5', output_tokens: 100 },
      { model: 'claude-sonnet-5', output_tokens: 7 },
    ]);
  });

  it('attributes a subagent turn to the parent session, not to the agent id', () => {
    writeSubagentTranscript(AGENT, turn('msg_sub', 'claude-sonnet-5', 7, true));

    captureModelUsage(db, cfg);

    const row = db.prepare('SELECT session_id FROM model_usage').get() as { session_id: string };
    expect(row.session_id).toBe(SESSION);
  });

  it('gives each transcript its own cursor, so siblings do not strand each other', () => {
    // The bug this guards: one cursor row per session let the subagent file's
    // offset overwrite the parent's. An offset is only a line boundary in the
    // file it came from — applied to a sibling it lands mid-line, that line
    // fails to parse, and the cursor still advances past it. The turn is lost
    // for good, since nothing ever re-reads bytes behind the cursor.
    const first = turn('msg_main_1', 'claude-opus-5', 100);
    const subagent = turn('msg_sub_1', 'claude-sonnet-5', 7, true, 'x'.repeat(400));
    const second = turn('msg_main_2', 'claude-opus-5', 100, false, 'y'.repeat(2000));
    // The subagent's offset has to land strictly inside the parent's next line
    // for the loss to happen at all.
    expect(subagent.length).toBeGreaterThan(first.length);
    expect(subagent.length).toBeLessThan(first.length + second.length);

    writeSessionTranscript(first);
    writeSubagentTranscript(AGENT, subagent);
    captureModelUsage(db, cfg);

    writeSessionTranscript(first + second);
    const pass = captureModelUsage(db, cfg);

    expect(pass.turnsInserted).toBe(1);
    expect(capturedTokens()).toBe(207);
  });

  it('re-reading inserts nothing new', () => {
    writeSessionTranscript(turn('msg_main', 'claude-opus-5', 100));
    writeSubagentTranscript(AGENT, turn('msg_sub', 'claude-sonnet-5', 7, true));

    captureModelUsage(db, cfg);
    const second = captureModelUsage(db, cfg);

    expect(second.turnsInserted).toBe(0);
    expect(capturedTokens()).toBe(107);
  });

  it('ignores subagents of a session trAIcker has no events for', () => {
    writeSubagentTranscript(AGENT, turn('msg_sub', 'claude-sonnet-5', 7, true));
    db.prepare('DELETE FROM events').run();
    seedEvent('other-session', upsertProject(db, projectDir, {}).id);

    captureModelUsage(db, cfg);

    expect(capturedTokens()).toBe(0);
  });
});

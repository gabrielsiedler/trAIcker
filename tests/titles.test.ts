import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { TraickerConfig } from '../src/core/config.js';
import { openDb, type Db } from '../src/core/db.js';
import { ingest } from '../src/ingest/index.js';
import { backfillTitles } from '../src/ingest/titles.js';

const SESSION = 'sess-titles-1';
const TZ = -180;
const DAY = '2026-08-10';

let root: string;
let home: string;
let projectDir: string;
let transcript: string;
let config: TraickerConfig;
let db: Db;
let realHome: string | undefined;
let realUserProfile: string | undefined;

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

/** One prompt event with no title and no excerpt, which is what keeps a session pending. */
function spoolPrompt(): void {
  const dir = path.join(config.spoolDir, DAY);
  mkdirSync(dir, { recursive: true });
  const record = {
    v: 1,
    e: 'UserPromptSubmit',
    t: '2026-08-10T12:00:00.000Z',
    tz: TZ,
    cwd: projectDir.replace(/\\/g, '/'),
    sid: SESSION,
    aid: null,
    at: null,
    pid: 'prompt-1',
    r: null,
    ttl: null,
    plen: 12,
    ex: null,
  };
  appendFileSync(path.join(dir, `${SESSION}.ndjson`), `${JSON.stringify(record)}\n`, 'utf8');
}

function titleLine(title: string): string {
  return `${JSON.stringify({ type: 'ai-title', aiTitle: title })}\n`;
}

function storedTitle(): string | null {
  const row = db
    .prepare('SELECT session_title FROM events WHERE session_id = ? LIMIT 1')
    .get(SESSION) as { session_title: string | null } | undefined;
  return row?.session_title ?? null;
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'traicker-titles-'));
  home = mkdtempSync(path.join(tmpdir(), 'traicker-home-'));
  projectDir = mkdtempSync(path.join(tmpdir(), 'traicker-proj-'));
  mkdirSync(path.join(projectDir, '.git'), { recursive: true });

  // backfillTitles reads ~/.claude/projects, and os.homedir() answers from the
  // environment, so a fake home is what isolates the scan from the real one.
  realHome = process.env['HOME'];
  realUserProfile = process.env['USERPROFILE'];
  process.env['HOME'] = home;
  process.env['USERPROFILE'] = home;

  const slug = path.join(home, '.claude', 'projects', 'test-project');
  mkdirSync(slug, { recursive: true });
  transcript = path.join(slug, `${SESSION}.jsonl`);

  config = makeConfig(root);
  db = openDb(config);
  spoolPrompt();
  ingest(db, config);
});

afterEach(() => {
  db.close();
  if (realHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = realHome;
  if (realUserProfile === undefined) delete process.env['USERPROFILE'];
  else process.env['USERPROFILE'] = realUserProfile;
  for (const dir of [root, home, projectDir]) rmSync(dir, { recursive: true, force: true });
});

describe('backfillTitles', () => {
  it('picks the title out of the transcript', () => {
    writeFileSync(transcript, titleLine('Fixing the tray icon'), 'utf8');

    const result = backfillTitles(db);

    expect(result.sessionsChecked).toBe(1);
    expect(storedTitle()).toBe('Fixing the tray icon');
  });

  it('does not re-read a transcript that has not grown', () => {
    // The regression. The session stays in the pending set forever, because its
    // prompt excerpt never arrives, and every pass used to re-read and re-parse
    // the whole file to find nothing. Across real history that was 617 MB and
    // 2.8s per sync, twice a minute, on the Electron main thread.
    writeFileSync(transcript, titleLine('Fixing the tray icon'), 'utf8');

    backfillTitles(db);
    const second = backfillTitles(db);

    expect(second.sessionsChecked).toBe(0);
    expect(storedTitle()).toBe('Fixing the tray icon');
  });

  it('reads the appended bytes when the transcript grows', () => {
    writeFileSync(transcript, titleLine('First guess'), 'utf8');
    backfillTitles(db);

    // A later turn re-emits the title, which is what makes a cursor safe here.
    appendFileSync(
      transcript,
      `${JSON.stringify({
        type: 'user',
        promptId: 'prompt-1',
        message: { content: 'what changed in the hook' },
      })}\n`,
      'utf8',
    );

    const third = backfillTitles(db);

    expect(third.sessionsChecked).toBe(1);
    expect(third.promptsEnriched).toBe(1);
  });

  it('starts over when the transcript shrinks', () => {
    writeFileSync(transcript, titleLine('Before rotation'), 'utf8');
    backfillTitles(db);

    // Rotated or replaced: shorter than the cursor, so the cursor is not trusted.
    writeFileSync(transcript, titleLine('X'), 'utf8');

    const after = backfillTitles(db);
    expect(after.sessionsChecked).toBe(1);
  });
});

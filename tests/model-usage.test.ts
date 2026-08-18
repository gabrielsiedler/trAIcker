import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { rollupModelUsage } from '../src/aggregate/modelUsage.js';
import type { TraickerConfig } from '../src/core/config.js';
import { openDb, upsertProject, type Db } from '../src/core/db.js';
import { modelUsageTotals } from '../src/report/cost.js';

const DAY = '2026-08-10';
const OTHER_DAY = '2026-08-11';
const RANGE = { from: '2026-08-01', to: '2026-08-31' };

let root: string;
let db: Db;
let projectId: number;
let cfg: TraickerConfig;

function config(dataDir: string): TraickerConfig {
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

let turnSeq = 0;

function addTurn(day: string, model: string, tokens: Partial<Record<'input' | 'output' | 'cacheWrite' | 'cacheRead', number>> = {}): void {
  turnSeq++;
  db.prepare(
    `INSERT INTO model_usage (
       message_id, project_id, session_id, local_day, ts_utc, model,
       input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens
     ) VALUES (?, ?, 's1', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    `msg_${turnSeq}`,
    projectId,
    day,
    `${day}T12:00:00.000Z`,
    model,
    tokens.input ?? 0,
    tokens.output ?? 0,
    tokens.cacheWrite ?? 0,
    tokens.cacheRead ?? 0,
  );
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'traicker-model-usage-'));
  cfg = config(root);
  db = openDb(cfg);
  projectId = upsertProject(db, path.join(root, 'acme'), {}).id;
  turnSeq = 0;
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe('rollupModelUsage', () => {
  it('sums raw turns per model within a day', () => {
    addTurn(DAY, 'claude-opus-5', { input: 100, output: 50 });
    addTurn(DAY, 'claude-opus-5', { input: 200, output: 75 });
    addTurn(DAY, 'claude-sonnet-5', { input: 10, output: 5 });

    rollupModelUsage(db, [DAY]);

    const rows = db.prepare('SELECT * FROM daily_model_usage WHERE local_day = ? ORDER BY model').all(DAY) as Array<{
      model: string;
      input_tokens: number;
      output_tokens: number;
      turn_count: number;
    }>;

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ model: 'claude-opus-5', input_tokens: 300, output_tokens: 125, turn_count: 2 });
    expect(rows[1]).toMatchObject({ model: 'claude-sonnet-5', input_tokens: 10, output_tokens: 5, turn_count: 1 });
  });

  it('is idempotent — rerunning does not double the totals', () => {
    addTurn(DAY, 'claude-opus-5', { input: 100 });

    rollupModelUsage(db, [DAY]);
    rollupModelUsage(db, [DAY]);

    const row = db.prepare('SELECT input_tokens FROM daily_model_usage WHERE local_day = ?').get(DAY) as {
      input_tokens: number;
    };
    expect(row.input_tokens).toBe(100);
  });

  it('only rewrites the days it was asked to', () => {
    addTurn(DAY, 'claude-opus-5', { input: 1 });
    addTurn(OTHER_DAY, 'claude-opus-5', { input: 1 });

    rollupModelUsage(db, [DAY, OTHER_DAY]);
    addTurn(DAY, 'claude-opus-5', { input: 1 }); // new raw row, day not re-rolled yet
    rollupModelUsage(db, [OTHER_DAY]);

    const untouched = db.prepare('SELECT input_tokens FROM daily_model_usage WHERE local_day = ?').get(DAY) as {
      input_tokens: number;
    };
    expect(untouched.input_tokens).toBe(1);
  });

  it('does nothing for an empty day list', () => {
    addTurn(DAY, 'claude-opus-5', { input: 1 });
    expect(() => rollupModelUsage(db, [])).not.toThrow();
    expect(db.prepare('SELECT COUNT(*) AS n FROM daily_model_usage').get()).toEqual({ n: 0 });
  });
});

describe('modelUsageTotals', () => {
  it('returns null cost for a model with no pricing entry', () => {
    addTurn(DAY, 'claude-opus-5', { input: 1_000_000, output: 1_000_000 });
    rollupModelUsage(db, [DAY]);

    const [row] = modelUsageTotals(db, RANGE, cfg);
    expect(row?.cost_usd).toBeNull();
    expect(row?.partiallyPriced).toBe(false);
  });

  it('computes cost from configured $/million rates', () => {
    addTurn(DAY, 'claude-opus-5', {
      input: 1_000_000,
      output: 500_000,
      cacheWrite: 2_000_000,
      cacheRead: 4_000_000,
    });
    rollupModelUsage(db, [DAY]);

    cfg.modelPricing['claude-opus-5'] = [
      { effectiveFrom: '2026-01-01', inputPerMillion: 15, outputPerMillion: 75, cacheWritePerMillion: 18.75, cacheReadPerMillion: 1.5 },
    ];

    const [row] = modelUsageTotals(db, RANGE, cfg);
    // 1*15 + 0.5*75 + 2*18.75 + 4*1.5 = 15 + 37.5 + 37.5 + 6 = 96
    expect(row?.cost_usd).toBeCloseTo(96, 6);
    expect(row?.partiallyPriced).toBe(false);
  });

  it('treats unset cache rates as $0 rather than guessing', () => {
    addTurn(DAY, 'claude-opus-5', { input: 1_000_000, cacheWrite: 1_000_000, cacheRead: 1_000_000 });
    rollupModelUsage(db, [DAY]);

    cfg.modelPricing['claude-opus-5'] = [{ effectiveFrom: '2026-01-01', inputPerMillion: 15, outputPerMillion: 75 }];

    const [row] = modelUsageTotals(db, RANGE, cfg);
    expect(row?.cost_usd).toBeCloseTo(15, 6);
  });

  it('groups by model across projects and days', () => {
    addTurn(DAY, 'claude-opus-5', { input: 10 });
    addTurn(OTHER_DAY, 'claude-opus-5', { input: 20 });
    rollupModelUsage(db, [DAY, OTHER_DAY]);

    const rows = modelUsageTotals(db, RANGE, cfg);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ model: 'claude-opus-5', input_tokens: 30, turn_count: 2 });
  });

  it('prices each day with the rate effective on that day, not the latest rate', () => {
    // A rate change mid-range must not rewrite what the earlier day already cost.
    addTurn(DAY, 'claude-opus-5', { input: 1_000_000 }); // 2026-08-10
    addTurn(OTHER_DAY, 'claude-opus-5', { input: 1_000_000 }); // 2026-08-11
    rollupModelUsage(db, [DAY, OTHER_DAY]);

    cfg.modelPricing['claude-opus-5'] = [
      { effectiveFrom: '2026-01-01', inputPerMillion: 15, outputPerMillion: 75 },
      { effectiveFrom: '2026-08-11', inputPerMillion: 10, outputPerMillion: 50 },
    ];

    const [row] = modelUsageTotals(db, RANGE, cfg);
    // DAY priced at 15/M, OTHER_DAY priced at the new 10/M rate: 15 + 10 = 25.
    expect(row?.cost_usd).toBeCloseTo(25, 6);
    expect(row?.partiallyPriced).toBe(false);
  });

  it('flags a partial estimate when only some days in range have a price', () => {
    addTurn(DAY, 'claude-opus-5', { input: 1_000_000 });
    addTurn(OTHER_DAY, 'claude-opus-5', { input: 1_000_000 });
    rollupModelUsage(db, [DAY, OTHER_DAY]);

    // Pricing starts the day after DAY, so DAY's usage predates any rate.
    cfg.modelPricing['claude-opus-5'] = [{ effectiveFrom: OTHER_DAY, inputPerMillion: 10, outputPerMillion: 50 }];

    const [row] = modelUsageTotals(db, RANGE, cfg);
    expect(row?.cost_usd).toBeCloseTo(10, 6); // only OTHER_DAY priced
    expect(row?.partiallyPriced).toBe(true);
  });
});

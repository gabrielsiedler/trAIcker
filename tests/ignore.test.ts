import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { TraickerConfig } from '../src/core/config.js';
import { openDb, type Db } from '../src/core/db.js';
import { normalizePath, pathKey } from '../src/core/paths.js';
import { resolveProjectId } from '../src/ingest/index.js';

let root: string;
let db: Db;
let config: TraickerConfig;

function makeConfig(dataDir: string): TraickerConfig {
  return {
    dataDir,
    dbPath: path.join(dataDir, 'time.db'),
    spoolDir: path.join(dataDir, 'spool'),
    idleTimeoutMinutes: 15,
    idleAttributionCapMinutes: 120,
    stitchGapMinutes: 10,
    maxTurnMinutes: 120,
    maxSubagentMinutes: 120,
    promptExcerptChars: 80,
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

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'traicker-ignore-'));
  config = makeConfig(root);
  db = openDb(config);
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

const key = (p: string) => pathKey(normalizePath(p));

describe('ignorePaths', () => {
  it('drops events under an ignored prefix', () => {
    const scratch = path.join(root, 'scratch');
    mkdirSync(path.join(scratch, '.git'), { recursive: true });
    config.ignorePaths = [key(scratch)];

    expect(resolveProjectId(db, config, scratch, new Map())).toBeNull();
  });

  it('never ignores a declared project inside an ignored workspace', () => {
    // Ignoring the workspace is how you stop bare sessions in it from becoming
    // a project. It must not delete every client that lives inside it.
    const workspace = path.join(root, 'dev');
    const client = path.join(workspace, 'acme');
    mkdirSync(client, { recursive: true });

    config.ignorePaths = [key(workspace)];
    config.projects = { [key(client)]: { name: 'Acme' } };

    const resolved = resolveProjectId(db, config, client, new Map());
    expect(resolved).not.toBeNull();

    const row = db.prepare('SELECT name FROM projects WHERE id = ?').get(resolved) as { name: string };
    expect(row.name).toBe('Acme');
  });

  it('still ignores the workspace directory itself', () => {
    const workspace = path.join(root, 'dev');
    const client = path.join(workspace, 'acme');
    mkdirSync(client, { recursive: true });

    config.ignorePaths = [key(workspace)];
    config.projects = { [key(client)]: { name: 'Acme' } };

    expect(resolveProjectId(db, config, workspace, new Map())).toBeNull();
  });

  it('tracks an undeclared project inside an ignored workspace', () => {
    // Ignoring the workspace must not swallow the projects living in it that
    // simply have no declaration yet — otherwise a real repository disappears
    // instead of showing up as its own project.
    const workspace = path.join(root, 'dev');
    const declared = path.join(workspace, 'acme');
    const other = path.join(workspace, 'side project');
    mkdirSync(declared, { recursive: true });
    mkdirSync(path.join(other, '.git'), { recursive: true });

    config.ignorePaths = [key(workspace)];
    config.projects = { [key(workspace)]: { name: 'dev' }, [key(declared)]: { name: 'Acme' } };

    const resolved = resolveProjectId(db, config, other, new Map());
    expect(resolved).not.toBeNull();
    const row = db.prepare('SELECT path FROM projects WHERE id = ?').get(resolved) as { path: string };
    expect(row.path).toBe(normalizePath(other));

    // A bare session in the workspace directory still lands on the workspace
    // itself — declared, so it outranks the ignore prefix — and never leaks
    // into the projects beside it.
    const bare = resolveProjectId(db, config, workspace, new Map());
    const bareRow = db.prepare('SELECT path FROM projects WHERE id = ?').get(bare) as { path: string };
    expect(bareRow.path).toBe(normalizePath(workspace));
  });

  it('still ignores everything under a plain ignored prefix', () => {
    const scratch = path.join(root, 'scratch');
    const inner = path.join(scratch, 'throwaway');
    mkdirSync(path.join(inner, '.git'), { recursive: true });
    config.ignorePaths = [key(scratch)];

    expect(resolveProjectId(db, config, inner, new Map())).toBeNull();
  });

  it('returns null from cache for a repeated ignored path', () => {
    const scratch = path.join(root, 'scratch');
    mkdirSync(path.join(scratch, '.git'), { recursive: true });
    config.ignorePaths = [key(scratch)];

    const cache = new Map<string, number>();
    expect(resolveProjectId(db, config, scratch, cache)).toBeNull();
    // The cached sentinel must not surface as a project id of -1.
    expect(resolveProjectId(db, config, scratch, cache)).toBeNull();
  });
});

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { configPath, type BillingConfig, type CommitmentConfig } from './config.js';
import { normalizePath, pathKey } from './paths.js';

export interface ProjectPatch {
  name?: string;
  client?: string | null;
  billable?: boolean;
  color?: string | null;
  commitment?: CommitmentConfig | null;
  billing?: BillingConfig | null;
}

/**
 * Writes project settings back into `~/.traicker/config.json`.
 *
 * The file stays the single source of truth, so hand edits keep working. That
 * means this must not flatten what it did not write: unknown keys are carried
 * through untouched, including the `_comment` entries that document each field
 * and would otherwise vanish the first time the dashboard saved anything.
 *
 * A timestamped backup is taken before every write.
 */
export function updateProjectConfig(projectPath: string, patch: ProjectPatch): string {
  const file = configPath();
  const raw = readConfig(file);

  const projects =
    typeof raw['projects'] === 'object' && raw['projects'] !== null
      ? { ...(raw['projects'] as Record<string, unknown>) }
      : {};

  // Config keys are written by hand, so a case difference must not create a
  // second entry for the same project.
  const wanted = pathKey(normalizePath(projectPath));
  const existingKey =
    Object.keys(projects).find((key) => pathKey(normalizePath(key)) === wanted) ?? normalizePath(projectPath);

  const current =
    typeof projects[existingKey] === 'object' && projects[existingKey] !== null
      ? { ...(projects[existingKey] as Record<string, unknown>) }
      : {};

  if (patch.name !== undefined) current['name'] = patch.name;
  if (patch.client !== undefined) {
    if (patch.client === null) delete current['client'];
    else current['client'] = patch.client;
  }
  if (patch.billable !== undefined) current['billable'] = patch.billable;
  if (patch.color !== undefined) {
    if (patch.color === null) delete current['color'];
    else current['color'] = patch.color;
  }

  if (patch.commitment !== undefined) {
    if (patch.commitment === null) delete current['commitment'];
    else current['commitment'] = { ...commentsOf(current['commitment']), ...patch.commitment };
  }

  if (patch.billing !== undefined) {
    if (patch.billing === null) delete current['billing'];
    else current['billing'] = { ...commentsOf(current['billing']), ...patch.billing };
  }

  projects[existingKey] = current;
  raw['projects'] = projects;

  const backup = backupAndWrite(file, `${JSON.stringify(raw, null, 2)}\n`);
  return backup;
}

/**
 * Keeps the `_`-prefixed documentation keys from a nested block.
 *
 * They explain what each setting means and are the reason the example config is
 * readable; a save that dropped them would quietly degrade the file every time.
 */
function commentsOf(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return {};
  const kept: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (key.startsWith('_')) kept[key] = v;
  }
  return kept;
}

function readConfig(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch (error) {
    // Refuse rather than overwrite: the file may hold settings that took
    // thought to get right, and a parse failure is not licence to discard them.
    throw new Error(`${file} is not valid JSON, refusing to overwrite it: ${String(error)}`);
  }
}

function backupAndWrite(file: string, contents: string): string {
  mkdirSync(path.dirname(file), { recursive: true });

  let backup = '';
  if (existsSync(file)) {
    backup = `${file}.backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    copyFileSync(file, backup);
  }

  writeFileSync(file, contents, 'utf8');
  return backup;
}

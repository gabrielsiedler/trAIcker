/**
 * DSH plugin install/uninstall helpers.
 *
 * Writes the trAIcker plugin entry into DSH's profile patch so the harness
 * loads it at boot.
 *
 * DSH profiles live under `$DSH_HOME/profiles/<name>/`, each with a
 * `package.json` (profile manifest) and `cordis.patch.yml` (user patch layer).
 * The patch is a YAML array with `insert` blocks.
 *
 * Two scopes:
 * - `user`  → `$DSH_HOME/profiles/web/cordis.patch.yml` (the default web profile)
 * - `project` → `<cwd>/.dsh/cordis.yml` (project-level DSH config)
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import type { TraickerConfig } from '../core/config.js';

/** trAIcker's DSH plugin npm package name. */
const PLUGIN_PACKAGE = '@traicker/dsh-plugin';

/**
 * Default DSH home directory.
 *
 * DeepSeek Harness uses `~/.dsh` as its home (see @deepseek-ai/dsh-home-paths:
 * DSH_HOME_DIR_NAME = '.dsh'), overridable by `$DSH_HOME`.
 */
function dshHome(): string {
  return process.env['DSH_HOME'] ?? path.join(homedir(), '.dsh');
}

export interface DshInstallResult {
  target: string;
  pluginPackage: string;
  alreadyPresent: boolean;
  after: string;
  backup: string | null;
}

export interface DshUninstallResult {
  target: string;
  found: boolean;
  backup: string | null;
}

/**
 * Resolve the target patch path for a scope.
 *
 * User scope: patches the `web` profile (`$DSH_HOME/profiles/web/cordis.patch.yml`).
 * Project scope: writes `.dsh/cordis.yml` at the project root.
 */
function resolveTarget(config: TraickerConfig, scope: 'user' | 'project'): string {
  if (scope === 'user') {
    return path.join(dshHome(), 'profiles', 'web', 'cordis.patch.yml');
  }
  // Project scope: use the first declared project root, or cwd.
  const roots = Object.keys(config.projects);
  const base = roots.length > 0 ? roots[0]! : process.cwd();
  return path.join(base, '.dsh', 'cordis.yml');
}

/**
 * Read a patch file, returning its lines (empty array if missing).
 */
function readLines(target: string): string[] {
  if (!existsSync(target)) return [];
  const raw = readFileSync(target, 'utf8');
  return raw.split(/\r?\n/);
}

/**
 * Generates the YAML patch entry for the trAIcker plugin.
 *
 * Uses `insert` block format (the DSH patch convention) so the plugin row
 * is added to the profile's composition.
 */
function generatePatchEntry(config: TraickerConfig): string {
  const spoolDir = config.spoolDir.replace(/\\/g, '/');
  const dbPath = config.dbPath.replace(/\\/g, '/');
  const excerptChars = config.promptExcerptChars;

  return [
    `- insert:`,
    `    - id: traicker`,
    `      name: '${PLUGIN_PACKAGE}'`,
    `      config:`,
    `        spoolDir: '${spoolDir}'`,
    `        dbPath: '${dbPath}'`,
    `        promptExcerptChars: ${excerptChars}`,
  ].join('\n');
}

/**
 * Writes the trAIcker plugin entry into DSH's profile patch.
 *
 * Adds an `insert` block to the patch YAML array. Creates the profile
 * directory and file if they don't exist. Takes a backup of the previous file.
 */
export function installDshPlugin(
  config: TraickerConfig,
  opts: { scope: 'user' | 'project'; dryRun?: boolean },
): DshInstallResult {
  const target = resolveTarget(config, opts.scope);
  const lines = readLines(target);
  const backup = existsSync(target)
    ? `${target}.traicker-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`
    : null;

  // Check if already present.
  const alreadyPresent = lines.some((l) => l.includes(PLUGIN_PACKAGE));

  const pluginEntry = generatePatchEntry(config);

  // Build the resulting file.
  let after: string;
  if (alreadyPresent) {
    after = lines.join('\n');
  } else if (lines.length === 0) {
    // No file yet — create a proper YAML array with the insert block.
    after = `# trAIcker DSH plugin — passive time tracking for AI-agent orchestration
# See https://github.com/gabrielsiedler/trAIcker
${pluginEntry}
`;
  } else {
    // Check if the file looks like a YAML array (starts with `- ` or `[`).
    const trimmed = lines.map((l) => l.trim()).filter(Boolean);
    const looksLikeArray = trimmed.length > 0 && trimmed[0]!.startsWith('- ');

    if (looksLikeArray) {
      // Append as a new array element.
      after = [...lines, pluginEntry.replace('- insert:', '  - insert:')].join('\n') + '\n';
    } else {
      // Wrap existing content and append.
      after = `${lines.join('\n')}\n${pluginEntry}\n`;
    }
  }

  if (!opts.dryRun && !alreadyPresent) {
    mkdirSync(path.dirname(target), { recursive: true });
    if (backup) copyFileSync(target, backup);
    writeFileSync(target, after, 'utf8');
  }

  return { target, pluginPackage: PLUGIN_PACKAGE, alreadyPresent, after, backup };
}

/**
 * Removes the trAIcker plugin entry from DSH's profile patch.
 */
export function uninstallDshPlugin(
  config: TraickerConfig,
  opts: { scope: 'user' | 'project' },
): DshUninstallResult {
  const target = resolveTarget(config, opts.scope);
  const lines = readLines(target);

  if (lines.length === 0) return { target, found: false, backup: null };

  const backup = `${target}.traicker-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;

  // Filter out lines related to the plugin (the insert block).
  const filtered: string[] = [];
  let skipBlock = false;
  let found = false;

  for (const line of lines) {
    if (line.includes(PLUGIN_PACKAGE)) {
      skipBlock = true;
      found = true;
      continue;
    }
    // If we're skipping, stop at the next top-level `- ` or end of file.
    if (skipBlock) {
      // A line starting with `- ` (not indented) is a new top-level entry.
      if (/^\s*-\s/.test(line) && !line.startsWith(' ') && !line.startsWith('\t')) {
        skipBlock = false;
        filtered.push(line);
      }
      continue;
    }
    filtered.push(line);
  }

  if (!found) return { target, found: false, backup: null };

  copyFileSync(target, backup);
  writeFileSync(target, filtered.join('\n') + '\n', 'utf8');

  return { target, found, backup };
}
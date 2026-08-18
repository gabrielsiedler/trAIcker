import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const IS_WINDOWS = process.platform === 'win32';

/** Markers that identify a directory as the root of a project. */
const ROOT_MARKERS = ['.git', '.claude', 'package.json', 'go.mod', 'Cargo.toml', 'pyproject.toml'];

/** How far up the tree `resolveProjectRoot` will walk before giving up. */
const MAX_WALK_UP = 12;

/** Expands a leading `~` and resolves to an absolute path. */
export function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(homedir(), p.slice(2));
  return p;
}

/**
 * Canonical display form of a filesystem path: absolute, forward slashes,
 * uppercase drive letter, no trailing separator.
 *
 * This is what the user sees. Matching is done on `pathKey` instead, because
 * Windows paths are case-insensitive and `C:/Dev/app` must not become a second
 * project alongside `C:/dev/app`.
 */
export function normalizePath(input: string): string {
  let p = path.resolve(expandHome(input.trim()));
  p = p.replace(/\\/g, '/');
  if (/^[a-z]:/.test(p)) p = p[0]!.toUpperCase() + p.slice(1);
  if (p.length > 1 && p.endsWith('/') && !/^[A-Za-z]:\/$/.test(p)) p = p.slice(0, -1);
  return p;
}

/** Case-folded key used for project identity. Never shown to the user. */
export function pathKey(normalized: string): string {
  return IS_WINDOWS ? normalized.toLowerCase() : normalized;
}

/**
 * Declared roots that hold other declared roots, and are therefore workspaces
 * rather than projects.
 *
 * A `C:/dev` that contains declared clients is a place projects live, not a
 * project. Left as an ordinary declared root it would capture every sibling
 * that has no declaration of its own — a real repository with its own `.git`
 * included — and the whole workspace would bill as one project named `dev`.
 * It still resolves for work done directly in it, so a bare session there is
 * attributable (and ignorable) as before.
 */
export function workspaceRoots(declaredRoots: readonly string[]): Set<string> {
  const workspaces = new Set<string>();
  for (const root of declaredRoots) {
    if (declaredRoots.some((other) => other !== root && other.startsWith(`${root}/`))) workspaces.add(root);
  }
  return workspaces;
}

/**
 * Resolves the project a working directory belongs to.
 *
 * Declared roots win over marker detection, and the longest match wins among
 * them. A path named in config is a project by definition — leaving that to the
 * filesystem misattributes work whenever a project has no marker of its own and
 * a parent directory does. A client directory sitting inside a `C:/dev` that
 * happens to hold a `.claude` folder would otherwise bill to `dev`.
 *
 * The exception is a declared root that contains other declared roots: that is
 * a workspace (see `workspaceRoots`), and it neither captures its children nor
 * terminates the walk-up — anything found beneath it is its own project.
 *
 * Deliberately NOT called from the hook: it touches the filesystem, and the
 * hook's only job is to append a line. Ingestion resolves roots instead, so the
 * rule can change and the whole history be reprocessed against the new one.
 *
 * Falls back to the normalized input when nothing matches, so an unmarked
 * directory still tracks as its own project rather than vanishing.
 *
 * @param declaredRoots Case-folded project paths from config (see `pathKey`).
 */
export function resolveProjectRoot(dir: string, declaredRoots: readonly string[] = []): string {
  const start = normalizePath(dir);
  const key = pathKey(start);
  const workspaces = workspaceRoots(declaredRoots);

  let bestMatch: string | null = null;
  for (const root of declaredRoots) {
    if (key === root) return start; // the workspace directory itself is still a root
    if (!key.startsWith(`${root}/`) || workspaces.has(root)) continue;
    if (bestMatch === null || root.length > bestMatch.length) bestMatch = root;
  }
  if (bestMatch !== null) {
    // Recover the display form by trimming the start path to the matched depth.
    return start.slice(0, bestMatch.length);
  }

  const home = normalizePath(homedir());
  let current = start;
  // Last directory walked past, so a workspace can hand back what sits directly
  // inside it rather than the deep subdirectory the walk started from.
  let child: string | null = null;

  for (let i = 0; i < MAX_WALK_UP; i++) {
    // Stop at the home directory. `~/.claude` exists for every Claude Code
    // install, so without this guard any unmarked project under home matches
    // there and every client's work bills to a project named after the user.
    if (pathKey(current) === pathKey(home)) break;

    // Stop at a workspace, and treat its immediate child as the project. An
    // unmarked directory inside a declared workspace is a project the user has
    // simply not declared yet — not part of the workspace above it.
    if (workspaces.has(pathKey(current))) return child ?? start;

    for (const marker of ROOT_MARKERS) {
      if (existsSync(path.join(current, marker))) return current;
    }
    const parent = normalizePath(path.dirname(current));
    if (parent === current) break;
    child = current;
    current = parent;
  }

  return start;
}

/** Human-facing default name for a project directory. */
export function defaultProjectName(normalized: string): string {
  const base = path.basename(normalized);
  return base.length > 0 ? base : normalized;
}

/** True when `p` exists and is a directory. */
export function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

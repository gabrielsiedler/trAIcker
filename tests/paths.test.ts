import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { normalizePath, pathKey, resolveProjectRoot } from '../src/core/paths.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'traicker-paths-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const declare = (...paths: string[]) => paths.map((p) => pathKey(normalizePath(p)));

describe('resolveProjectRoot', () => {
  it('finds the nearest directory carrying a marker', () => {
    const project = path.join(root, 'client');
    mkdirSync(path.join(project, '.git'), { recursive: true });
    mkdirSync(path.join(project, 'src', 'api'), { recursive: true });

    expect(resolveProjectRoot(path.join(project, 'src', 'api'))).toBe(normalizePath(project));
  });

  it('absorbs an unmarked project into a marked parent — the failure mode', () => {
    // A workspace root with a .claude folder, holding a client directory that
    // has no marker of its own.
    mkdirSync(path.join(root, '.claude'), { recursive: true });
    const client = path.join(root, 'acme');
    mkdirSync(client, { recursive: true });

    // Without a declaration, the walk-up reaches the workspace and the client's
    // work bills to the wrong project.
    expect(resolveProjectRoot(client)).toBe(normalizePath(root));
  });

  it('lets a declared root win over a marked parent', () => {
    mkdirSync(path.join(root, '.claude'), { recursive: true });
    const client = path.join(root, 'acme');
    mkdirSync(path.join(client, 'api'), { recursive: true });

    const declared = declare(client);
    expect(resolveProjectRoot(client, declared)).toBe(normalizePath(client));
    // Subdirectories resolve to the declared root too.
    expect(resolveProjectRoot(path.join(client, 'api'), declared)).toBe(normalizePath(client));
  });

  it('picks the longest declared root when several match', () => {
    const outer = path.join(root, 'dev');
    const inner = path.join(outer, 'client');
    mkdirSync(inner, { recursive: true });

    expect(resolveProjectRoot(inner, declare(outer, inner))).toBe(normalizePath(inner));
  });

  it('does not let a declared workspace swallow an undeclared project inside it', () => {
    // Regression: declaring the workspace itself (so bare sessions in it are
    // attributable) made it capture every sibling project that had no
    // declaration of its own, and the whole tree billed as one project.
    const workspace = path.join(root, 'dev');
    const declared = path.join(workspace, 'acme');
    const other = path.join(workspace, 'side project');
    mkdirSync(declared, { recursive: true });
    mkdirSync(path.join(other, '.git'), { recursive: true });

    const roots = declare(workspace, declared);
    expect(resolveProjectRoot(other, roots)).toBe(normalizePath(other));
    expect(resolveProjectRoot(declared, roots)).toBe(normalizePath(declared));
    // Work done directly in the workspace still resolves to it.
    expect(resolveProjectRoot(workspace, roots)).toBe(normalizePath(workspace));
  });

  it('treats the child of a declared workspace as a project even with no marker', () => {
    const workspace = path.join(root, 'dev');
    const declared = path.join(workspace, 'acme');
    const unmarked = path.join(workspace, 'araceli');
    mkdirSync(declared, { recursive: true });
    mkdirSync(path.join(unmarked, 'src'), { recursive: true });

    const roots = declare(workspace, declared);
    expect(resolveProjectRoot(unmarked, roots)).toBe(normalizePath(unmarked));
    expect(resolveProjectRoot(path.join(unmarked, 'src'), roots)).toBe(normalizePath(unmarked));
  });

  it('keeps a declared root that holds no other declaration intact', () => {
    // A monorepo declared once must not split into its packages.
    const repo = path.join(root, 'monorepo');
    const pkg = path.join(repo, 'packages', 'api');
    mkdirSync(pkg, { recursive: true });
    mkdirSync(path.join(pkg, '.git'), { recursive: true });

    expect(resolveProjectRoot(pkg, declare(repo))).toBe(normalizePath(repo));
  });

  it('does not match a declared root that is only a string prefix', () => {
    // "client" must not swallow "client-two".
    const declared = declare(path.join(root, 'client'));
    const other = path.join(root, 'client-two');
    mkdirSync(other, { recursive: true });

    expect(resolveProjectRoot(other, declared)).toBe(normalizePath(other));
  });

  it('falls back to the directory itself when nothing matches', () => {
    const lonely = path.join(root, 'no-markers-anywhere');
    mkdirSync(lonely, { recursive: true });

    // root itself has no marker either, so the walk finds nothing.
    expect(resolveProjectRoot(lonely)).toBe(normalizePath(lonely));
  });

  it('never walks past the home directory', () => {
    // ~/.claude exists on every Claude Code install. Without a guard, the walk
    // matches it and every unmarked project under home bills to one project
    // named after the user.
    const lonely = path.join(root, 'unmarked');
    mkdirSync(lonely, { recursive: true });

    const resolved = resolveProjectRoot(lonely);
    expect(pathKey(resolved)).not.toBe(pathKey(normalizePath(homedir())));
  });

  it('resolves a declared root case-insensitively on Windows', () => {
    if (process.platform !== 'win32') return;

    const client = path.join(root, 'Acme');
    mkdirSync(client, { recursive: true });

    const declared = declare(client.toLowerCase());
    expect(pathKey(resolveProjectRoot(client, declared))).toBe(pathKey(normalizePath(client)));
  });
});

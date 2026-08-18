import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadEnvFile } from '../src/core/env.js';

let root: string;
const TOUCHED = ['OPENROUTER_API_KEY', 'TR_A', 'TR_B', 'TR_QUOTED', 'TR_HASH', 'TR_EMPTY', 'TR_EQ'];

function writeEnv(body: string): void {
  writeFileSync(path.join(root, '.env'), body, 'utf8');
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'traicker-env-'));
  process.env['TRAICKER_DATA_DIR'] = root;
  for (const key of TOUCHED) delete process.env[key];
});

afterEach(() => {
  delete process.env['TRAICKER_DATA_DIR'];
  for (const key of TOUCHED) delete process.env[key];
  rmSync(root, { recursive: true, force: true });
});

describe('loadEnvFile', () => {
  it('reports a missing file without throwing', () => {
    const result = loadEnvFile();
    expect(result.found).toBe(false);
    expect(result.applied).toEqual([]);
  });

  it('reads a key into the environment', () => {
    writeEnv('OPENROUTER_API_KEY=sk-or-v1-abc\n');
    const result = loadEnvFile();

    expect(process.env['OPENROUTER_API_KEY']).toBe('sk-or-v1-abc');
    expect(result.applied).toEqual(['OPENROUTER_API_KEY']);
  });

  it('lets a real environment variable win', () => {
    // So `OPENROUTER_API_KEY=... traicker translate` overrides the file for one
    // run without editing it — and so a key exported in CI is never shadowed.
    process.env['OPENROUTER_API_KEY'] = 'from-shell';
    writeEnv('OPENROUTER_API_KEY=from-file\n');

    const result = loadEnvFile();
    expect(process.env['OPENROUTER_API_KEY']).toBe('from-shell');
    expect(result.skipped).toEqual(['OPENROUTER_API_KEY']);
    expect(result.applied).toEqual([]);
  });

  it('treats an empty environment variable as unset', () => {
    process.env['TR_A'] = '';
    writeEnv('TR_A=real\n');

    loadEnvFile();
    expect(process.env['TR_A']).toBe('real');
  });

  it('ignores blanks and comments, and accepts export', () => {
    writeEnv(['# a comment', '', '  ', 'export TR_A=one', 'TR_B = two '].join('\n'));

    loadEnvFile();
    expect(process.env['TR_A']).toBe('one');
    expect(process.env['TR_B']).toBe('two');
  });

  it('strips one layer of quotes', () => {
    writeEnv(['TR_QUOTED="sk-or-v1-quoted"', "TR_A='single'"].join('\n'));

    loadEnvFile();
    expect(process.env['TR_QUOTED']).toBe('sk-or-v1-quoted');
    expect(process.env['TR_A']).toBe('single');
  });

  it('keeps a # that is part of the value', () => {
    // Treating it as a comment would silently truncate a key containing one,
    // and a key that is quietly wrong is worse than one that is plainly absent.
    writeEnv('TR_HASH=abc#def\n');

    loadEnvFile();
    expect(process.env['TR_HASH']).toBe('abc#def');
  });

  it('keeps everything after the first equals sign', () => {
    writeEnv('TR_EQ=a=b=c\n');

    loadEnvFile();
    expect(process.env['TR_EQ']).toBe('a=b=c');
  });

  it('skips malformed lines rather than failing the run', () => {
    writeEnv(['no-equals-here', '=novalue', '9BAD=x', 'TR_A=good'].join('\n'));

    const result = loadEnvFile();
    expect(result.applied).toEqual(['TR_A']);
    expect(process.env['9BAD']).toBeUndefined();
  });

  it('allows an intentionally empty value', () => {
    writeEnv('TR_EMPTY=\n');

    loadEnvFile();
    expect(process.env['TR_EMPTY']).toBe('');
  });
});

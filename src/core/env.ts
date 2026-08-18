import { readFileSync } from 'node:fs';
import path from 'node:path';

import { dataDir } from './config.js';

export interface LoadedEnv {
  /** Where it looked, whether or not anything was there. */
  file: string;
  found: boolean;
  /** Names only. The values are secrets and are never returned or logged. */
  applied: string[];
  /** Present in the file but already set in the environment, which wins. */
  skipped: string[];
}

/**
 * Reads `<dataDir>/.env` into `process.env`.
 *
 * Not a repo-local `.env.local`: trAIcker is installed once and run from
 * whatever directory you happen to be in, so a file next to the source would be
 * found only when you were standing in it. The key is a credential of yours,
 * not an artefact of a project, so it lives with the rest of trAIcker's state.
 *
 * Deliberately NOT called from the hook. The hook runs inside your session on
 * every prompt and its budget is one appended line — it has no business reading
 * another file, and it never needs a key.
 *
 * A real environment variable always wins, so a one-off
 * `OPENROUTER_API_KEY=... traicker translate` overrides the file without
 * editing it.
 */
export function loadEnvFile(): LoadedEnv {
  const file = path.join(dataDir(), '.env');
  const result: LoadedEnv = { file, found: false, applied: [], skipped: [] };

  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    // Absent is the normal case, not an error.
    return result;
  }

  result.found = true;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq <= 0) continue;

    const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    if (process.env[key] !== undefined && process.env[key] !== '') {
      result.skipped.push(key);
      continue;
    }

    process.env[key] = unquote(line.slice(eq + 1).trim());
    result.applied.push(key);
  }

  return result;
}

/**
 * Strips one layer of matching quotes.
 *
 * An unquoted value keeps any trailing `#` — treating it as a comment would
 * silently truncate a key that happened to contain one, and a key that is
 * quietly wrong is worse than one that is obviously missing.
 */
function unquote(value: string): string {
  if (value.length >= 2 && (value.startsWith('"') || value.startsWith("'"))) {
    const quote = value[0]!;
    const end = value.lastIndexOf(quote);
    if (end > 0) return value.slice(1, end);
  }
  return value;
}

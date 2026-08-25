/**
 * NDJSON spool writer for the DSH plugin.
 *
 * Mirrors the same append pattern as `src/hook.ts` so the downstream ingest
 * pipeline treats lines from either source identically.
 *
 * Difference from the hook: the plugin runs inside Cordis, so there is no
 * stdin to read, no stdout to avoid contaminating, and no 2-second watchdog
 * (the Cordis event loop manages this).
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

/**
 * Writes one NDJSON line to `<spoolDir>/<local-day>/<session>.ndjson`.
 *
 * Sharded by session id so concurrent sessions never collide. Parallel
 * subagents in one session share one file, but every line is < 300 bytes
 * so O_APPEND remains atomic.
 */
export function appendSpoolRecord(
  spoolDir: string,
  sid: string,
  timestampIso: string,
  tzOffsetMinutes: number,
  record: unknown,
): void {
  const day = localDayFromIso(timestampIso, tzOffsetMinutes);
  const file = path.join(spoolDir, day, `${safeSegment(sid)}.ndjson`);
  const line = `${JSON.stringify(record)}\n`;

  try {
    appendFileSync(file, line, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return;
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      appendFileSync(file, line, 'utf8');
    } catch {
      /* dropped — a write failure never blocks the agent */
    }
  }
}

/** Strips anything that could escape the spool directory. */
function safeSegment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 100);
  return cleaned.length > 0 ? cleaned : 'unknown';
}

/**
 * Local day from an ISO timestamp + UTC offset in minutes.
 *
 * Duplicates the logic in `src/hook.ts` so the plugin produces the exact
 * same day partitioning.
 */
export function localDayFromIso(iso: string, tzOffsetMinutes: number): string {
  return new Date(Date.parse(iso) + tzOffsetMinutes * 60_000)
    .toISOString()
    .slice(0, 10);
}
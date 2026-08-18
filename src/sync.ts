import { loadConfig, type TraickerConfig } from './core/config.js';
import { openDb, refreshProjectMetadata, type Db } from './core/db.js';
import { MS_PER_DAY, localDay, localOffsetMinutes } from './core/time.js';
import { aggregate, type AggregateResult } from './aggregate/run.js';
import { rollupModelUsage } from './aggregate/modelUsage.js';
import { ingest, type IngestResult } from './ingest/index.js';
import { backfillTitles, type TitleBackfillResult } from './ingest/titles.js';
import { captureModelUsage, type UsageCaptureResult } from './ingest/usage.js';

export interface SyncResult {
  ingest: IngestResult;
  titles: TitleBackfillResult;
  usage: UsageCaptureResult;
  aggregate: AggregateResult;
}

/**
 * Ingest, then aggregate. The single entry point every trigger shares — the
 * detached SessionEnd spawn, the CLI's lazy refresh before printing, and the
 * dashboard's refresh before serving.
 *
 * Safe to run concurrently with itself: ingestion is guarded by the spool
 * cursor plus a UNIQUE constraint, and aggregation is a pure rebuild inside a
 * transaction.
 */
export function sync(db: Db, config: TraickerConfig, extraDays: readonly string[] = []): SyncResult {
  // Config edits to a project's name, client or billable flag land here rather
  // than waiting for the next event in that project.
  refreshProjectMetadata(db, config.projects);

  const ingestResult = ingest(db, config);

  // Titles appear in the transcript shortly after a session starts, so this
  // runs every pass rather than once at ingestion. A day whose title changed
  // must be rebuilt: descriptions are derived from it.
  const titleResult = backfillTitles(db);

  // Independent of focus/agent/occupancy aggregation below — cost has no
  // interval-merge dependency on spans, so it rebuilds off its own affected
  // days rather than joining the same rebuild set.
  const usageResult = captureModelUsage(db, config);
  rollupModelUsage(db, usageResult.affectedDays);

  // Today and yesterday are always rebuilt even with no new events: spans still
  // in flight are recorded as 'open' and grow until they close or hit a cap.
  // `extraDays` covers the one thing that touches the event log without
  // producing an event: a hand-logged entry for a day in the past. Without it,
  // a meeting backdated to last week never lands in that day's spans until
  // something else happens to rebuild it.
  const now = Date.now();
  const offset = localOffsetMinutes();
  const days = new Set([...ingestResult.affectedDays, ...titleResult.affectedDays, ...extraDays]);
  days.add(localDay(now, offset));
  days.add(localDay(now - MS_PER_DAY, offset));

  return {
    ingest: ingestResult,
    titles: titleResult,
    usage: usageResult,
    aggregate: aggregate(db, config, { days: [...days], now }),
  };
}

/** Convenience wrapper that opens the database from the on-disk config. */
export function syncFromConfig(): { config: TraickerConfig; db: Db; result: SyncResult } {
  const config = loadConfig();
  const db = openDb(config);
  return { config, db, result: sync(db, config) };
}

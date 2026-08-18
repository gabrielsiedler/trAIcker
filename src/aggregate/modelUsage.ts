import type { Db } from '../core/db.js';

/**
 * Rebuilds `daily_model_usage` for the given local days from the raw
 * `model_usage` rows.
 *
 * A plain SQL delete-and-rewrite, same idempotent shape as the rest of
 * aggregation — but unlike focus/agent/occupancy this is a pure SUM with no
 * interval merging: spend has no overlap to reconcile, so there is nothing
 * for a JS-side accumulator to do that SQL doesn't already do in one pass.
 */
export function rollupModelUsage(db: Db, days: readonly string[]): void {
  if (days.length === 0) return;

  const del = db.prepare('DELETE FROM daily_model_usage WHERE local_day = ?');
  const ins = db.prepare(
    `INSERT INTO daily_model_usage (
       local_day, project_id, model, input_tokens, output_tokens,
       cache_creation_input_tokens, cache_read_input_tokens, turn_count
     )
     SELECT local_day, project_id, model,
            SUM(input_tokens), SUM(output_tokens),
            SUM(cache_creation_input_tokens), SUM(cache_read_input_tokens), COUNT(*)
     FROM model_usage
     WHERE local_day = ?
     GROUP BY project_id, model`,
  );

  db.transaction(() => {
    for (const day of days) {
      del.run(day);
      ins.run(day);
    }
  })();
}

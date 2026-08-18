import { pricingFor, type ModelPricingEntry, type TraickerConfig } from '../core/config.js';
import type { Db } from '../core/db.js';
import { filterClause, params, type DateRange } from './queries.js';

export interface ModelUsageRow {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  turn_count: number;
  /** null when no day in range had an applicable price. */
  cost_usd: number | null;
  /**
   * True when at least one day in range had usage but no price effective yet
   * — `cost_usd` is a partial sum, not the full range's cost.
   */
  partiallyPriced: boolean;
}

interface DailyUsageRow {
  local_day: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  turn_count: number;
}

interface Accumulator {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  turn_count: number;
  costSum: number;
  pricedDays: number;
  totalDays: number;
}

/**
 * Token usage and estimated spend per model, over a range.
 *
 * Priced day by day rather than as one range total: a rate change partway
 * through the range must not be applied to days that happened under the old
 * rate, so each day's tokens are priced with whatever was effective that day
 * before the days are summed back into one row per model.
 */
export function modelUsageTotals(
  db: Db,
  range: DateRange,
  config: TraickerConfig,
  projectFilter?: string,
): ModelUsageRow[] {
  const rows = db
    .prepare(
      `SELECT m.local_day, m.model,
              SUM(m.input_tokens)                AS input_tokens,
              SUM(m.output_tokens)                AS output_tokens,
              SUM(m.cache_creation_input_tokens)  AS cache_creation_input_tokens,
              SUM(m.cache_read_input_tokens)      AS cache_read_input_tokens,
              SUM(m.turn_count)                   AS turn_count
       FROM daily_model_usage m
       JOIN projects p ON p.id = m.project_id
       WHERE m.local_day BETWEEN ? AND ?${filterClause(projectFilter)}
       GROUP BY m.local_day, m.model`,
    )
    .all(...params(range, projectFilter)) as DailyUsageRow[];

  const byModel = new Map<string, Accumulator>();

  for (const row of rows) {
    let acc = byModel.get(row.model);
    if (!acc) {
      acc = {
        model: row.model,
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        turn_count: 0,
        costSum: 0,
        pricedDays: 0,
        totalDays: 0,
      };
      byModel.set(row.model, acc);
    }

    acc.input_tokens += row.input_tokens;
    acc.output_tokens += row.output_tokens;
    acc.cache_creation_input_tokens += row.cache_creation_input_tokens;
    acc.cache_read_input_tokens += row.cache_read_input_tokens;
    acc.turn_count += row.turn_count;
    acc.totalDays++;

    const pricing = pricingFor(config, row.model, row.local_day);
    if (pricing) {
      acc.costSum += costOf(row, pricing);
      acc.pricedDays++;
    }
  }

  return [...byModel.values()]
    .sort((a, b) => b.input_tokens + b.output_tokens - (a.input_tokens + a.output_tokens))
    .map((acc) => ({
      model: acc.model,
      input_tokens: acc.input_tokens,
      output_tokens: acc.output_tokens,
      cache_creation_input_tokens: acc.cache_creation_input_tokens,
      cache_read_input_tokens: acc.cache_read_input_tokens,
      turn_count: acc.turn_count,
      cost_usd: acc.pricedDays === 0 ? null : acc.costSum,
      partiallyPriced: acc.pricedDays > 0 && acc.pricedDays < acc.totalDays,
    }));
}

function costOf(usage: DailyUsageRow, pricing: ModelPricingEntry): number {
  const perMillion = (tokens: number, rate: number): number => (tokens / 1_000_000) * rate;

  return (
    perMillion(usage.input_tokens, pricing.inputPerMillion) +
    perMillion(usage.output_tokens, pricing.outputPerMillion) +
    perMillion(usage.cache_creation_input_tokens, pricing.cacheWritePerMillion ?? 0) +
    perMillion(usage.cache_read_input_tokens, pricing.cacheReadPerMillion ?? 0)
  );
}

interface DailyProjectUsageRow extends DailyUsageRow {
  project_id: number;
}

interface CostAccumulator {
  costSum: number;
  pricedRows: number;
  totalRows: number;
}

function accumulate(acc: CostAccumulator, row: DailyUsageRow, config: TraickerConfig): void {
  acc.totalRows++;
  const pricing = pricingFor(config, row.model, row.local_day);
  if (pricing) {
    acc.costSum += costOf(row, pricing);
    acc.pricedRows++;
  }
}

function settle(acc: CostAccumulator): { cost_usd: number | null; partiallyPriced: boolean } {
  return {
    cost_usd: acc.pricedRows === 0 ? null : acc.costSum,
    partiallyPriced: acc.pricedRows > 0 && acc.pricedRows < acc.totalRows,
  };
}

function dailyProjectModelUsage(db: Db, range: DateRange, projectFilter?: string): DailyProjectUsageRow[] {
  return db
    .prepare(
      `SELECT m.local_day, m.project_id, m.model,
              SUM(m.input_tokens)                AS input_tokens,
              SUM(m.output_tokens)                AS output_tokens,
              SUM(m.cache_creation_input_tokens)  AS cache_creation_input_tokens,
              SUM(m.cache_read_input_tokens)      AS cache_read_input_tokens,
              SUM(m.turn_count)                   AS turn_count
       FROM daily_model_usage m
       JOIN projects p ON p.id = m.project_id
       WHERE m.local_day BETWEEN ? AND ?${filterClause(projectFilter)}
       GROUP BY m.local_day, m.project_id, m.model`,
    )
    .all(...params(range, projectFilter)) as DailyProjectUsageRow[];
}

export interface ProjectCostRow {
  project_id: number;
  /** null when no priced day/model combination fell in range for this project. */
  cost_usd: number | null;
  /** True when some usage in range had no applicable price yet — a partial sum. */
  partiallyPriced: boolean;
}

/** Estimated spend per project over a range, priced day by day like {@link modelUsageTotals}. */
export function projectCostTotals(db: Db, range: DateRange, config: TraickerConfig, projectFilter?: string): ProjectCostRow[] {
  const rows = dailyProjectModelUsage(db, range, projectFilter);
  const byProject = new Map<number, CostAccumulator>();

  for (const row of rows) {
    let acc = byProject.get(row.project_id);
    if (!acc) {
      acc = { costSum: 0, pricedRows: 0, totalRows: 0 };
      byProject.set(row.project_id, acc);
    }
    accumulate(acc, row, config);
  }

  return [...byProject.entries()].map(([project_id, acc]) => ({ project_id, ...settle(acc) }));
}

export interface DayCostRow {
  local_day: string;
  project_id: number;
  cost_usd: number | null;
  partiallyPriced: boolean;
}

/** Estimated spend per project per day over a range, for the timeline. */
export function dailyCostTotals(db: Db, range: DateRange, config: TraickerConfig, projectFilter?: string): DayCostRow[] {
  const rows = dailyProjectModelUsage(db, range, projectFilter);
  const byDay = new Map<string, CostAccumulator & { local_day: string; project_id: number }>();

  for (const row of rows) {
    const key = `${row.local_day}|${row.project_id}`;
    let acc = byDay.get(key);
    if (!acc) {
      acc = { local_day: row.local_day, project_id: row.project_id, costSum: 0, pricedRows: 0, totalRows: 0 };
      byDay.set(key, acc);
    }
    accumulate(acc, row, config);
  }

  return [...byDay.values()].map(({ local_day, project_id, ...acc }) => ({ local_day, project_id, ...settle(acc) }));
}

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { expandHome, normalizePath, pathKey } from './paths.js';
import { WEEK_START_DAYS, type WeekStart } from './time.js';

export type { WeekStart };

function parseWeekStart(value: unknown, fallback: WeekStart): WeekStart {
  return typeof value === 'string' && (WEEK_START_DAYS as readonly string[]).includes(value)
    ? (value as WeekStart)
    : fallback;
}

/**
 * A weekly hours arrangement, independent of whether anything gets submitted.
 *
 * `cap` and `target` are opposite obligations and must not share a field: a cap
 * is breached from above (10h/week contractual ceiling), a target is missed
 * from below (a part-time commitment you are expected to meet). Collapsing them
 * would make the alert fire in the wrong direction for one of the two.
 */
export interface CommitmentConfig {
  weeklyHours: number;
  kind: 'cap' | 'target';
  weekStartsOn: WeekStart;
}

/** Per-project billing rules. Only projects that carry one are invoiced. */
export interface BillingConfig {
  /**
   * What an hour means for this client.
   *
   * `occupancy` bills the wall-clock the project was being worked on, by you or
   * by an agent you directed. `focus` bills only your attention — far smaller,
   * and appropriate only if the client is paying for presence rather than
   * delivery.
   */
  basis: 'occupancy' | 'focus';
  /**
   * Contractual ceiling. Reported against, never silently enforced.
   *
   * @deprecated Prefer a project-level `commitment` block with `kind: "cap"`.
   *   Still read so existing configs keep working.
   */
  weeklyCapHours?: number;
  /** Timesheet rounding granularity, in minutes. */
  roundToMinutes: number;
  weekStartsOn: WeekStart;
  /**
   * Allow raw prompt excerpts as timesheet descriptions when Claude Code has
   * not produced a title.
   *
   * Off by default. An excerpt is unedited text you typed to an agent — often
   * in the wrong language for the client, sometimes containing things that have
   * no business on an invoice.
   */
  allowExcerpts: boolean;
  /**
   * Translate descriptions into this language before they reach the client
   * (e.g. `"English"`). Omit to leave labels in whatever language the work
   * happened in.
   *
   * Translations are cached per source string, so a week re-rendered later
   * reads identically — an LLM in a billing path has to be deterministic.
   */
  translateTo?: string;
}

/**
 * $ per million tokens for one Claude model, effective from a given local day
 * until the next entry (for the same model) takes over.
 *
 * A model's price is a list of these rather than a single rate: a provider's
 * rate changes over time, and a month already worked has to keep costing what
 * it cost that month even after the rate changes — otherwise editing today's
 * price silently rewrites the estimate for every past invoice.
 */
export interface ModelPricingEntry {
  /** `YYYY-MM-DD`, local day. Applies to usage on or after this day. */
  effectiveFrom: string;
  inputPerMillion: number;
  outputPerMillion: number;
  /**
   * Omit to treat cache writes/reads as contributing $0 to the estimate.
   * Safer to visibly undercount than to silently assume a rate that might be
   * wrong — cache tokens are typically priced well below a plain input token.
   */
  cacheWritePerMillion?: number;
  cacheReadPerMillion?: number;
}

export interface ProjectOverride {
  name?: string;
  client?: string;
  billable?: boolean;
  /** `#rrggbb`. Omitted means the colour is derived from the project id. */
  color?: string;
  /** Present only for projects that produce a timesheet. */
  billing?: BillingConfig;
  /** Weekly hours arrangement. Independent of timesheets. */
  commitment?: CommitmentConfig;
}

export interface TraickerConfig {
  /** Root of all trAIcker state. */
  dataDir: string;
  /** SQLite database file. */
  dbPath: string;
  /** Directory holding the NDJSON spool, sharded by day then session. */
  spoolDir: string;

  /**
   * A focus interval is capped at this many minutes. If the next prompt lands
   * later than that, the excess is dead time, not focus.
   */
  idleTimeoutMinutes: number;
  /**
   * Ceiling on how much of a single gap is reported as discarded idle time.
   *
   * Without it, the gap between Monday evening and Tuesday morning is recorded
   * as fourteen hours of "idle", drowning the signal the number exists for:
   * interruptions inside a working stretch. A gap longer than this is not idle,
   * it is off the clock, and is reported as nothing at all.
   */
  idleAttributionCapMinutes: number;

  /** Ceiling for a main-loop turn that never saw a Stop (crash, hard kill). */
  maxTurnMinutes: number;
  /** Ceiling for a subagent span that never saw a SubagentStop. */
  maxSubagentMinutes: number;

  /**
   * How many characters of the prompt to keep as a fallback label when Claude
   * Code has not generated a session title yet. Set to 0 to never store prompt
   * text at all.
   */
  promptExcerptChars: number;

  /**
   * Gaps shorter than this are absorbed into an occupancy block.
   *
   * Without it, an agent finishing at 10:25 and your next prompt at 10:30 would
   * bill as two blocks with a hole between them — a hole that only exists
   * because nothing emitted an event while you read the output.
   */
  stitchGapMinutes: number;

  /** Fully-ingested spool files older than this are archived or deleted. */
  spoolRetentionDays: number;
  spoolRetentionAction: 'archive' | 'delete' | 'keep';

  /** Project paths (or prefixes) to drop at ingestion time. */
  ignorePaths: string[];

  /** Per-project display overrides, keyed by project path. */
  projects: Record<string, ProjectOverride>;

  /**
   * $/million-token history per model, keyed by the model name Claude Code
   * itself reports (e.g. `"claude-opus-5"`) — an internal estimate only,
   * never shown to a client. Each model maps to a list of `ModelPricingEntry`
   * ordered by `effectiveFrom` ascending. Empty by default: provider pricing
   * changes, and shipping numbers that might already be stale is worse than
   * an explicit "not configured".
   */
  modelPricing: Record<string, ModelPricingEntry[]>;

  /** Local dashboard port. */
  serverPort: number;

  /**
   * Model used to write and translate timesheet descriptions.
   *
   * An OpenRouter model slug — provider-prefixed, e.g. `anthropic/claude-opus-5`
   * rather than `claude-opus-5`. Must be one that supports structured outputs;
   * see https://openrouter.ai/models?supported_parameters=structured_outputs.
   *
   * Both jobs are light and the default is priced accordingly. Raising it is a
   * call about your money and your invoices, so it is a setting rather than
   * something decided for you.
   */
  translationModel: string;

  /**
   * OpenAI-compatible endpoint the model calls go to.
   *
   * A setting because the endpoint and the key travel together: pointing this
   * somewhere else without also changing `OPENROUTER_API_KEY` sends your key to
   * a host that did not issue it.
   */
  llmBaseUrl: string;
}

const DEFAULT_DATA_DIR = path.join(homedir(), '.traicker');

function defaults(dataDir: string): TraickerConfig {
  return {
    dataDir,
    dbPath: path.join(dataDir, 'time.db'),
    spoolDir: path.join(dataDir, 'spool'),
    idleTimeoutMinutes: 15,
    idleAttributionCapMinutes: 120,
    maxTurnMinutes: 120,
    maxSubagentMinutes: 120,
    promptExcerptChars: 80,
    stitchGapMinutes: 10,
    spoolRetentionDays: 7,
    spoolRetentionAction: 'archive',
    ignorePaths: [],
    projects: {},
    modelPricing: {},
    serverPort: 4317,
    translationModel: 'deepseek/deepseek-v4-flash-0731',
    llmBaseUrl: 'https://openrouter.ai/api/v1',
  };
}

/** Where the config file lives. `TRAICKER_DATA_DIR` relocates the whole tree. */
export function configPath(): string {
  return path.join(dataDirFromEnv(), 'config.json');
}

/** Root of trAIcker's state, honouring `TRAICKER_DATA_DIR`. */
export function dataDir(): string {
  return dataDirFromEnv();
}

function dataDirFromEnv(): string {
  const override = process.env.TRAICKER_DATA_DIR;
  return override && override.trim().length > 0 ? path.resolve(expandHome(override)) : DEFAULT_DATA_DIR;
}

function num(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/**
 * `#rgb` or `#rrggbb`, nothing else.
 *
 * The value reaches a `style` attribute in the dashboard, so it is checked at
 * every boundary rather than trusted because it came from a local file.
 */
export function isHexColor(value: string): boolean {
  return /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value.trim());
}

function strArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
}

/**
 * Loads config, falling back to defaults for anything missing or malformed.
 *
 * This never throws. A broken config file must not be able to take down the
 * hook — a tracker that can wedge your editor is worse than no tracker.
 */
export function loadConfig(): TraickerConfig {
  const dataDir = dataDirFromEnv();
  const config = defaults(dataDir);

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
  } catch {
    return config;
  }
  if (typeof raw !== 'object' || raw === null) return config;
  const o = raw as Record<string, unknown>;

  if (typeof o['dbPath'] === 'string') config.dbPath = path.resolve(expandHome(o['dbPath']));
  if (typeof o['spoolDir'] === 'string') config.spoolDir = path.resolve(expandHome(o['spoolDir']));

  config.idleTimeoutMinutes = num(o['idleTimeoutMinutes'], config.idleTimeoutMinutes, 1, 720);
  config.idleAttributionCapMinutes = num(o['idleAttributionCapMinutes'], config.idleAttributionCapMinutes, 0, 1440);
  config.maxTurnMinutes = num(o['maxTurnMinutes'], config.maxTurnMinutes, 1, 1440);
  config.maxSubagentMinutes = num(o['maxSubagentMinutes'], config.maxSubagentMinutes, 1, 1440);
  config.promptExcerptChars = Math.floor(num(o['promptExcerptChars'], config.promptExcerptChars, 0, 500));
  config.stitchGapMinutes = num(o['stitchGapMinutes'], config.stitchGapMinutes, 0, 120);
  config.spoolRetentionDays = Math.floor(num(o['spoolRetentionDays'], config.spoolRetentionDays, 0, 3650));
  config.serverPort = Math.floor(num(o['serverPort'], config.serverPort, 1, 65535));

  if (typeof o['translationModel'] === 'string' && o['translationModel'].trim().length > 0) {
    config.translationModel = o['translationModel'].trim();
  }

  if (typeof o['llmBaseUrl'] === 'string' && o['llmBaseUrl'].trim().length > 0) {
    config.llmBaseUrl = o['llmBaseUrl'].trim();
  }

  if (o['spoolRetentionAction'] === 'archive' || o['spoolRetentionAction'] === 'delete' || o['spoolRetentionAction'] === 'keep') {
    config.spoolRetentionAction = o['spoolRetentionAction'];
  }

  const ignore = strArray(o['ignorePaths']);
  if (ignore) config.ignorePaths = ignore.map((p) => pathKey(normalizePath(p)));

  if (typeof o['projects'] === 'object' && o['projects'] !== null) {
    for (const [key, value] of Object.entries(o['projects'] as Record<string, unknown>)) {
      if (typeof value !== 'object' || value === null) continue;
      const v = value as Record<string, unknown>;
      const override: ProjectOverride = {};
      if (typeof v['name'] === 'string') override.name = v['name'];
      if (typeof v['client'] === 'string') override.client = v['client'];
      if (typeof v['billable'] === 'boolean') override.billable = v['billable'];
      if (typeof v['color'] === 'string' && isHexColor(v['color'])) override.color = v['color'].toLowerCase();

      const billing = parseBilling(v['billing']);
      if (billing) override.billing = billing;

      const commitment = parseCommitment(v['commitment'], billing);
      if (commitment) override.commitment = commitment;

      config.projects[pathKey(normalizePath(key))] = override;
    }
  }

  if (typeof o['modelPricing'] === 'object' && o['modelPricing'] !== null) {
    for (const [model, value] of Object.entries(o['modelPricing'] as Record<string, unknown>)) {
      const entries = parseModelPricingEntries(value);
      if (entries.length > 0) config.modelPricing[model] = entries;
    }
  }

  return config;
}

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Parses one model's price history, dropping invalid entries and sorting by `effectiveFrom`. */
function parseModelPricingEntries(raw: unknown): ModelPricingEntry[] {
  if (!Array.isArray(raw)) return [];

  const entries: ModelPricingEntry[] = [];
  for (const item of raw) {
    const entry = parseModelPricingEntry(item);
    if (entry) entries.push(entry);
  }

  return entries.sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? -1 : a.effectiveFrom > b.effectiveFrom ? 1 : 0));
}

function parseModelPricingEntry(raw: unknown): ModelPricingEntry | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const p = raw as Record<string, unknown>;

  if (typeof p['effectiveFrom'] !== 'string' || !DAY_PATTERN.test(p['effectiveFrom'])) return null;
  if (typeof p['inputPerMillion'] !== 'number' || !Number.isFinite(p['inputPerMillion'])) return null;
  if (typeof p['outputPerMillion'] !== 'number' || !Number.isFinite(p['outputPerMillion'])) return null;

  const entry: ModelPricingEntry = {
    effectiveFrom: p['effectiveFrom'],
    inputPerMillion: Math.max(0, p['inputPerMillion']),
    outputPerMillion: Math.max(0, p['outputPerMillion']),
  };

  if (typeof p['cacheWritePerMillion'] === 'number' && Number.isFinite(p['cacheWritePerMillion'])) {
    entry.cacheWritePerMillion = Math.max(0, p['cacheWritePerMillion']);
  }
  if (typeof p['cacheReadPerMillion'] === 'number' && Number.isFinite(p['cacheReadPerMillion'])) {
    entry.cacheReadPerMillion = Math.max(0, p['cacheReadPerMillion']);
  }

  return entry;
}

function parseBilling(raw: unknown): BillingConfig | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const b = raw as Record<string, unknown>;

  const billing: BillingConfig = {
    basis: b['basis'] === 'focus' ? 'focus' : 'occupancy',
    roundToMinutes: Math.floor(num(b['roundToMinutes'], 15, 1, 60)),
    weekStartsOn: parseWeekStart(b['weekStartsOn'], 'monday'),
    allowExcerpts: b['allowExcerpts'] === true,
  };

  if (typeof b['translateTo'] === 'string' && b['translateTo'].trim().length > 0) {
    billing.translateTo = b['translateTo'].trim();
  }

  if (typeof b['weeklyCapHours'] === 'number' && Number.isFinite(b['weeklyCapHours'])) {
    billing.weeklyCapHours = Math.max(0, b['weeklyCapHours']);
  }

  return billing;
}

/**
 * Reads a commitment block, falling back to a deprecated `billing.weeklyCapHours`
 * so configs written before the two concepts were separated keep working.
 */
function parseCommitment(raw: unknown, billing: BillingConfig | null): CommitmentConfig | null {
  if (typeof raw === 'object' && raw !== null) {
    const c = raw as Record<string, unknown>;
    if (typeof c['weeklyHours'] === 'number' && Number.isFinite(c['weeklyHours']) && c['weeklyHours'] > 0) {
      return {
        weeklyHours: c['weeklyHours'],
        kind: c['kind'] === 'target' ? 'target' : 'cap',
        weekStartsOn: parseWeekStart(c['weekStartsOn'], billing?.weekStartsOn ?? 'monday'),
      };
    }
  }

  if (billing?.weeklyCapHours !== undefined && billing.weeklyCapHours > 0) {
    return { weeklyHours: billing.weeklyCapHours, kind: 'cap', weekStartsOn: billing.weekStartsOn };
  }

  return null;
}

/** Looks up the billing rules for a project path, if any. */
export function billingFor(config: TraickerConfig, projectPath: string): BillingConfig | null {
  return config.projects[pathKey(normalizePath(projectPath))]?.billing ?? null;
}

/** Looks up the weekly hours arrangement for a project path, if any. */
export function commitmentFor(config: TraickerConfig, projectPath: string): CommitmentConfig | null {
  return config.projects[pathKey(normalizePath(projectPath))]?.commitment ?? null;
}

/**
 * The price in effect for a model on a given local day.
 *
 * Entries are sorted ascending by `effectiveFrom`, so the answer is the last
 * one at or before `day` — the most recent rate that had already taken effect
 * when that day's usage happened. `null` when the model has no pricing at
 * all, or when `day` is before every entry (usage predates any recorded rate).
 */
export function pricingFor(config: TraickerConfig, model: string, day: string): ModelPricingEntry | null {
  const entries = config.modelPricing[model];
  if (!entries || entries.length === 0) return null;

  let match: ModelPricingEntry | null = null;
  for (const entry of entries) {
    if (entry.effectiveFrom > day) break;
    match = entry;
  }
  return match;
}

/**
 * Minimal config slice the hook needs, resolved without touching the DB.
 *
 * Note what is absent: `ignorePaths`. The hook does not filter — see the
 * comment in src/hook.ts. Filtering is an ingestion decision because ingestion
 * can be re-run, and a line the hook never wrote cannot be recovered.
 */
export interface HookConfig {
  spoolDir: string;
  promptExcerptChars: number;
}

/**
 * Cheap config read for the hook path.
 *
 * Reads the same file as `loadConfig` but tolerates absolutely anything,
 * including the file not existing, and returns hardcoded defaults on failure.
 */
export function loadHookConfig(): HookConfig {
  const dataDir = dataDirFromEnv();
  const fallback: HookConfig = {
    spoolDir: path.join(dataDir, 'spool'),
    promptExcerptChars: 80,
  };

  try {
    const o = JSON.parse(readFileSync(path.join(dataDir, 'config.json'), 'utf8')) as Record<string, unknown>;
    if (typeof o['spoolDir'] === 'string') fallback.spoolDir = path.resolve(expandHome(o['spoolDir']));
    if (typeof o['promptExcerptChars'] === 'number' && Number.isFinite(o['promptExcerptChars'])) {
      fallback.promptExcerptChars = Math.min(500, Math.max(0, Math.floor(o['promptExcerptChars'])));
    }
  } catch {
    /* defaults are fine */
  }

  return fallback;
}

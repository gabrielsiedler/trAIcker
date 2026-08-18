export type RangeSpec = 'today' | 'yesterday' | 'week' | 'month' | 'all';

export interface DateRange {
  from: string;
  to: string;
}

export interface ProjectTotal {
  project_id: number;
  project_name: string;
  client: string | null;
  billable: number;
  color?: string | null;
  focus_ms: number;
  agent_wall_ms: number;
  agent_effort_ms: number;
  /**
   * Billable wall-clock: union of focus and agent, short gaps stitched.
   * Optional because a server from an older build omits it entirely.
   */
  occupancy_ms?: number;
  idle_dropped_ms: number;
  prompt_count: number;
  subagent_count: number;
  active_days: number;
  /**
   * Estimated LLM spend — an internal figure, never shown to a client. Null
   * when there's no `modelPricing` entry covering the usage yet, same as
   * `ModelUsage.cost_usd`. Optional because an older server omits it.
   */
  cost_usd?: number | null;
  /** True when some usage in range had no applicable price yet — a partial sum. */
  cost_partially_priced?: boolean;
}

export interface ProjectDay extends ProjectTotal {
  local_day: string;
  session_count: number;
}


export interface TimelineSpan {
  bucket: 'focus' | 'agent' | 'occupancy';
  source: 'prompt_gap' | 'main_turn' | 'subagent' | 'billable_block';
  project_id: number;
  project_name: string;
  /** Drives lane order and the billable filter without a second request. */
  billable: number;
  color: string | null;
  title: string | null;
  agent_type: string | null;
  start_utc: string;
  end_utc: string;
  duration_ms: number;
  truncated_by: string | null;
}

export interface SummaryResponse {
  range: DateRange;
  totals: ProjectTotal[];
  days: ProjectDay[];
}

export interface ModelUsage {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  turn_count: number;
  /** null when no pricing entry exists for this model — not the same as $0. */
  cost_usd: number | null;
  /** true when only part of the range had an applicable price — cost_usd is a partial sum. */
  partiallyPriced: boolean;
}

export interface ModelUsageResponse {
  range: DateRange;
  models: ModelUsage[];
  /** Model names present in the range with no `modelPricing` entry. */
  unpriced: string[];
}

export interface BillableProject {
  id: number;
  name: string;
  path: string;
  client: string | null;
  billable: number;
  hasBilling: boolean;
}

export type DescriptionSource = 'manual-note' | 'day-summary' | 'translated' | 'generated' | 'fallback';

export interface TimesheetEntry {
  day: string;
  rawMs: number;
  hours: number;
  description: string;
  /** Where the line came from — you wrote it, a model wrote it, or it was joined. */
  descriptionSource: DescriptionSource;
  topics: string[];
}

export interface TimesheetWeek {
  weekStart: string;
  entries: TimesheetEntry[];
  hours: number;
  capHours: number | null;
  overCap: boolean;
}

export interface TimesheetResponse {
  project: string;
  client: string | null;
  /** False when the project has no billing block and defaults were used. */
  configured: boolean;
  billing: { basis: 'occupancy' | 'focus'; weeklyCapHours?: number; roundToMinutes: number; weekStartsOn: WeekStart };
  range: DateRange;
  sheet: {
    projectName: string;
    basis: string;
    weeks: TimesheetWeek[];
    totalHours: number;
  } | null;
}

export const MANUAL_KINDS = ['meeting', 'research', 'review', 'admin', 'other'] as const;
export type ManualKind = (typeof MANUAL_KINDS)[number];

export interface ManualEntry {
  id: number;
  project_id: number;
  project_name: string;
  start_utc: string;
  end_utc: string;
  tz_offset_min: number;
  kind: ManualKind;
  note: string | null;
}

export const WEEK_START_DAYS = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
] as const;
export type WeekStart = (typeof WEEK_START_DAYS)[number];

export interface Commitment {
  weeklyHours: number;
  kind: 'cap' | 'target';
  weekStartsOn: WeekStart;
}

export interface Billing {
  basis: 'occupancy' | 'focus';
  roundToMinutes: number;
  weekStartsOn: WeekStart;
  allowExcerpts: boolean;
}

export interface ProjectSettings {
  id: number;
  name: string;
  path: string;
  client: string | null;
  billable: number;
  color: string | null;
  configured: boolean;
  commitment: Commitment | null;
  billing: Billing | null;
}

/** Carries the server's message rather than a bare status code. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
  }
}

// Above the server's 60s LLM call timeout (see TIMEOUT_MS in summarize.ts) so a
// slow-but-alive request isn't cut off before the server has a chance to fail
// it itself — this only fires when the connection actually stalls or drops.
const REQUEST_TIMEOUT_MS = 90_000;

async function send<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  const text = await response.text();
  const parsed: unknown = text.length > 0 ? JSON.parse(text) : {};

  if (!response.ok) {
    const message =
      typeof parsed === 'object' && parsed !== null && typeof (parsed as { error?: unknown }).error === 'string'
        ? (parsed as { error: string }).error
        : `${method} ${path} failed: ${response.status}`;
    throw new ApiError(message, response.status, parsed);
  }

  return parsed as T;
}

async function get<T>(path: string, params: Record<string, string | undefined>): Promise<T> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) query.set(key, value);
  }

  const response = await fetch(`${path}?${query.toString()}`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`${path} failed: ${response.status}`);
  return (await response.json()) as T;
}

/**
 * Either a named preset or an explicit window — the server resolves both the
 * same way — optionally narrowed to one project.
 *
 * `project` is matched as a fragment against name and path server-side, which
 * is why it travels as a string rather than an id.
 */
export type RangeQuery = ({ range: RangeSpec } | { from: string; to: string }) & { project?: string };

function rangeParams(query: RangeQuery): Record<string, string | undefined> {
  const window = 'range' in query ? { range: query.range } : { from: query.from, to: query.to };
  return { ...window, project: query.project };
}

export const api = {
  summary: (query: RangeQuery) => get<SummaryResponse>('/api/summary', rangeParams(query)),
  timeline: (query: RangeQuery) =>
    get<{ range: DateRange; spans: TimelineSpan[] }>('/api/timeline', rangeParams(query)),
  models: (query: RangeQuery) => get<ModelUsageResponse>('/api/models', rangeParams(query)),
  projects: () => get<{ projects: BillableProject[] }>('/api/projects', {}),
  timesheet: (project: string, from?: string, to?: string) =>
    get<TimesheetResponse>('/api/timesheet', { project, from, to }),
  summariseDay: (project: string, day: string) =>
    send<{ ok: true; day: string; summary: string; inputKind: 'titles' | 'excerpts'; inputCount: number }>(
      'POST',
      '/api/timesheet/summary',
      { project, day },
    ),
  clearDaySummary: (project: string, day: string) =>
    send<{ ok: true; removed: boolean }>(
      'DELETE',
      `/api/timesheet/summary?project=${encodeURIComponent(project)}&day=${encodeURIComponent(day)}`,
    ),
  setDayNote: (project: string, day: string, text: string) =>
    send<{ ok: true; day: string; note: string }>('POST', '/api/timesheet/note', { project, day, text }),
  clearDayNote: (project: string, day: string) =>
    send<{ ok: true; removed: boolean }>(
      'DELETE',
      `/api/timesheet/note?project=${encodeURIComponent(project)}&day=${encodeURIComponent(day)}`,
    ),

  entries: (from: string, to: string) => get<{ entries: ManualEntry[] }>('/api/entries', { from, to }),
  addEntry: (entry: {
    projectId: number;
    day: string;
    from: string;
    to?: string;
    duration?: string;
    kind: ManualKind;
    note?: string;
    force?: boolean;
  }) => send<{ ok: true; entry: ManualEntry }>('POST', '/api/entries', entry),
  deleteEntry: (id: number) => send<{ ok: true }>('DELETE', `/api/entries/${id}`),

  projectSettings: () =>
    get<{ configPath: string; projects: ProjectSettings[] }>('/api/projects/settings', {}),
  saveProject: (
    id: number,
    patch: {
      name?: string;
      client?: string | null;
      billable?: boolean;
      color?: string | null;
      commitment?: Commitment | null;
      billing?: Billing | null;
    },
  ) => send<{ ok: true; backup: string }>('PATCH', `/api/projects/${id}`, patch),
};

/**
 * Start of the week containing `day`, mirroring the server's rule so the
 * dashboard's week navigation lines up with the cap it reports against.
 */
const WEEK_START_INDEX: Record<WeekStart, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

export function weekStartOf(day: string, startsOn: WeekStart = 'monday'): string {
  const ms = Date.parse(`${day}T00:00:00.000Z`);
  if (!Number.isFinite(ms)) return day;
  const weekday = new Date(ms).getUTCDay();
  const back = (weekday - WEEK_START_INDEX[startsOn] + 7) % 7;
  return new Date(ms - back * 86_400_000).toISOString().slice(0, 10);
}

export function shiftDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** `Mon 10 Aug` — compact enough for a dense table. */
export function shortDate(day: string): string {
  return new Date(`${day}T12:00:00.000Z`).toLocaleDateString(undefined, {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
  });
}

/**
 * Coerces a possibly-missing numeric field to 0.
 *
 * A long-running `traicker serve` from before a field existed still answers,
 * and arithmetic on the missing field turns every derived total into NaN. A
 * stale server should degrade to zeros, not to garbage across the whole page.
 */
export function num(value: number | undefined | null): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** `2h 05m` / `47m` / `38s` — mirrors the CLI so the two never disagree. */
export function formatDuration(ms: number | undefined | null): string {
  const total = num(ms);
  if (total <= 0) return '0m';
  const minutes = Math.floor(total / 60_000);
  if (minutes === 0) return `${Math.round(total / 1000)}s`;
  const hours = Math.floor(minutes / 60);
  return hours > 0 ? `${hours}h ${String(minutes % 60).padStart(2, '0')}m` : `${minutes}m`;
}

/** `$1.23` / `—` for a model with no pricing configured — never `$0.00`, which would read as free rather than unknown. */
export function formatCost(usd: number | null | undefined): string {
  if (usd === null || usd === undefined) return '—';
  return `$${usd.toFixed(2)}`;
}

/** How the timesheet renders a quantity of billable hours. */
export type HoursFormat = 'decimal' | 'clock';

const HOURS_FORMAT_KEY = 'traicker.hoursFormat';

/** Reads the saved preference, defaulting to decimal for a first run. */
export function loadHoursFormat(): HoursFormat {
  const stored = localStorage.getItem(HOURS_FORMAT_KEY);
  return stored === 'clock' ? 'clock' : 'decimal';
}

export function saveHoursFormat(format: HoursFormat): void {
  localStorage.setItem(HOURS_FORMAT_KEY, format);
}

/**
 * `5.50` or `5:30` — decimal is what the raw numbers already are, clock is
 * how most client timesheets show them. Same underlying value either way,
 * so switching the toggle must not change what gets billed.
 */
export function formatHours(hours: number, format: HoursFormat): string {
  if (format === 'decimal') return hours.toFixed(2);
  const totalMinutes = Math.round(hours * 60);
  const wholeHours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${wholeHours}:${String(minutes).padStart(2, '0')}`;
}

/** Agent wall-clock per unit of focus — the leverage number. */
export function leverage(focusMs: number | undefined, agentWallMs: number | undefined): string {
  const focus = num(focusMs);
  if (focus <= 0) return '—';
  return `${(num(agentWallMs) / focus).toFixed(1)}×`;
}

/**
 * The colour a project is drawn in, everywhere it appears.
 *
 * A chosen colour wins. The fallback is derived from the id, which is stable
 * for a given project but is a function of insertion order — so adding a
 * project can recolour a later one. That is the reason choosing is worth
 * offering: the hue is how you find a client in the strip without reading.
 */
export function projectColor(projectId: number, chosen?: string | null): string {
  if (chosen && /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(chosen)) return chosen;
  const hues = [199, 152, 43, 340, 265, 15, 180, 95];
  return `hsl(${hues[projectId % hues.length]!} 70% 55%)`;
}

export function localTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function todayLocal(): string {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}

import type OpenAI from 'openai';

import type { TraickerConfig } from '../core/config.js';
import type { Db } from '../core/db.js';
import { describeApiError, openRouter, routeToStructuredOutput, textFrom } from './client.js';

/** What the model was allowed to read. Recorded alongside the result. */
export type SummaryInputKind = 'titles' | 'excerpts';

export interface DayActivity {
  /** Session and task titles, largest share of the day first. */
  titles: readonly string[];
  /** Truncated prompt text, in the order it was typed. */
  excerpts: readonly string[];
}

export interface SummarizeResult {
  summary: string | null;
  inputKind: SummaryInputKind;
  inputCount: number;
  error: string | null;
}

/**
 * The length the model is asked for — a timesheet line, not a changelog,
 * matching the generated-description cap. Not the storage limit: models
 * regularly overshoot a character-count instruction by a wide margin, and
 * chopping every overshoot down to exactly this length silently threw away
 * real content mid-sentence. The dashboard clamps the display to a couple of
 * lines and lets it expand instead, so the full answer needs to actually
 * reach storage.
 */
const MAX_CHARS = 220;

/** The only real limit past prompting: guards against a runaway response, not routine length. */
const STORAGE_MAX_CHARS = 4000;

/** A day's prompts, bounded so one very long day cannot blow up the request. */
const MAX_EXCERPTS = 120;

const TIMEOUT_MS = 60_000;

/**
 * The answer is one 220-character line — about 60 tokens — but reasoning is
 * requested off (see `routeToStructuredOutput`) rather than guaranteed off:
 * not every provider a model routes through honours `reasoning: { effort:
 * 'none' }`. This stays generous as the fallback for one that doesn't, so a
 * big day (many titles, many prompts) still has room to finish the JSON
 * instead of getting truncated mid-object.
 */
const MAX_TOKENS = 16_384;

const SYSTEM_PROMPT = [
  'You write one line of a freelance timesheet. THE CLIENT READS IT. They are paying for this day',
  'and they know their own product — they do not know, and are not buying, how the work was carried out.',
  '',
  'You are given fragments of the day: session titles, and the opening words of each instruction the',
  'developer typed while working. The fragments are truncated, out of context, full of internal',
  'shorthand, and often in a different language than the output must be. They are evidence of what',
  'was worked on. They are NOT the line, and their vocabulary is not the client\'s.',
  '',
  'Write ONE continuous line naming what the client got out of the day.',
  '',
  'Say WHAT now exists, works, or was decided — in the words the client would use for their own',
  'product. Never say HOW it was produced.',
  '',
  'Leave out entirely, even when the fragments are full of them:',
  '- How the work was done: AI agents, automation, parallel execution, orchestration, prompting,',
  '  tooling, editors. That is the developer\'s method and it is not what is being billed.',
  '- Internal identifiers: ticket and task codes (AP2, B9, CT1), branch names, board column names.',
  '  A client cannot look these up and they read as noise on an invoice.',
  '- Local development trivia: port numbers, environment variables, lint, formatting, dependency',
  '  installs, local config. Fold it into the feature it served, or drop it.',
  '- File paths, URLs, people\'s names, email addresses.',
  '',
  'Worked example. Fragments like "vamos de IN2", "pode usar o skill de commit", "porque estamos',
  'usando vite e nao nextjs?", "standardize dev ports to 4000", "orchestrate agents for AP2/AP3/AP8"',
  'become:',
  '  BAD:  "Orchestrated parallel agents to implement AP2, AP3 and AP8; standardized dev ports to',
  '        4000 and aligned board statuses with acceptance criteria."',
  '  GOOD: "Set the initial delivery priorities, established the project repository and deployment',
  '        pipeline, and began moving the web app to a framework that supports server rendering."',
  '',
  'Further rules:',
  '- Cover the whole day. A day usually holds several distinct threads; name the substantial ones',
  '  and drop the trivia. Do not let the largest thread crowd out the rest.',
  '- Report only what the fragments support. Never invent a deliverable, a status, or a number, and',
  '  never claim something shipped or was approved unless a fragment says so.',
  '- Describe the work, not the conversation: "Evaluated two rendering approaches and began the',
  '  migration", never "asked why Vite was chosen".',
  '- Plain prose in one line: no bullets, no newlines, no headings, no first person.',
  `- Hard limit ${MAX_CHARS} characters.`,
  '- If the fragments say nothing a client would recognise as work on their product, return an',
  '  empty string rather than padding.',
].join('\n');

/**
 * Writes a day's timesheet description from everything that happened that day.
 *
 * This exists because the generated description cannot answer the question. It
 * joins session titles, and Claude Code names a session once, from its opening
 * minutes — so a day spent on eight tasks inside one long session reports the
 * name of the first one. The prompts are the only per-task signal that survives.
 *
 * Never throws. A missing key or a network failure leaves the existing
 * description in place; the caller reports the error and nothing is written.
 */
export async function summarizeDay(
  config: TraickerConfig,
  activity: DayActivity,
  targetLang: string | undefined,
): Promise<SummarizeResult> {
  const titles = activity.titles.map(clean).filter((t) => t.length > 0);
  const excerpts = activity.excerpts
    .map(clean)
    .filter((t) => t.length > 0)
    .slice(0, MAX_EXCERPTS);

  // Excerpts are the whole point — they are the only per-task signal — but a
  // day can legitimately have none, and titles alone still beat failing.
  const inputKind: SummaryInputKind = excerpts.length > 0 ? 'excerpts' : 'titles';
  const inputCount = excerpts.length > 0 ? excerpts.length : titles.length;

  const result: SummarizeResult = {
    summary: null,
    inputKind,
    inputCount,
    error: null,
  };
  if (titles.length === 0 && excerpts.length === 0) {
    result.error = 'no activity recorded for that day';
    return result;
  }

  let client: OpenAI;
  try {
    client = openRouter(config, TIMEOUT_MS);
  } catch (error) {
    result.error = describeApiError(error);
    return result;
  }

  try {
    const completion = await client.chat.completions.create(
      routeToStructuredOutput({
        model: config.translationModel,
        max_tokens: MAX_TOKENS,
        // A billing line must not reword itself on a re-run. The result is stored
        // either way, but a redo you asked for should differ because the day
        // changed, not because of sampling.
        temperature: 0,
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'timesheet_line',
            strict: true,
            schema: {
              type: 'object',
              properties: {
                description: {
                  type: 'string',
                  description: `One continuous line, at most ${MAX_CHARS} characters. Empty if the fragments say nothing about the work.`,
                },
              },
              required: ['description'],
              additionalProperties: false,
            },
          },
        },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userMessage(titles, excerpts, targetLang) },
        ],
      }),
    );

    const summary = readDescription(textFrom(completion));
    if (summary.length === 0) {
      result.error = 'the model returned an empty description';
      return result;
    }

    result.summary = truncate(summary, STORAGE_MAX_CHARS);
    return result;
  } catch (error) {
    result.error = describeApiError(error);
    return result;
  }
}

/**
 * The description, whether or not the model wrapped it in the schema.
 *
 * OpenRouter routes one model across several providers and they do not all
 * honour `response_format`, even with `require_parameters` set — the same
 * request came back as `{"description": "Set up a fresh…"}` five times and as
 * bare `Set up a fresh…` the sixth. The bare form is exactly the string wanted,
 * so failing on it threw away a good answer and showed a JSON parser's
 * complaint to someone who had pressed a button labelled "redo".
 *
 * Salvage is deliberately narrow: one line, within the cap, and not the opening
 * of some other structure. Anything else is a different failure wearing prose.
 */
export function readDescription(text: string): string {
  const raw = text.trim();

  try {
    const parsed = JSON.parse(raw) as { description?: unknown };
    return typeof parsed.description === 'string' ? clean(parsed.description) : '';
  } catch {
    // Not JSON. Fall through.
  }

  if (raw.startsWith('{') || raw.startsWith('[')) return '';
  const line = clean(raw);
  if (line.length === 0 || line.length > STORAGE_MAX_CHARS) return '';
  return line;
}

function userMessage(titles: readonly string[], excerpts: readonly string[], targetLang: string | undefined): string {
  const parts: string[] = [];

  // Stated first so it governs. English by default rather than mirroring the
  // fragments' language — the fragments are internal notes, not the client's
  // language, and a project without an explicit translateTo still needs a
  // client-facing line in English.
  parts.push(`Write the line in ${targetLang ?? 'English'}.`, '');

  if (titles.length > 0) {
    parts.push('Session titles, in order of how much of the day each accounted for:');
    parts.push(...titles.map((t) => `- ${t}`), '');
  }

  if (excerpts.length > 0) {
    parts.push(
      'Opening words of each instruction given during the day, in order. These are truncated',
      'mid-sentence and are evidence of what was worked on, not text to quote:',
    );
    parts.push(...excerpts.map((e) => `- ${e}`));
  }

  return parts.join('\n');
}

/** Reads a stored summary, or null. */
export function readDaySummary(db: Db, projectId: number, day: string): string | null {
  const row = db
    .prepare('SELECT summary FROM day_summaries WHERE local_day = ? AND project_id = ?')
    .get(day, projectId) as { summary: string } | undefined;
  return row?.summary ?? null;
}

export function saveDaySummary(
  db: Db,
  projectId: number,
  day: string,
  result: SummarizeResult,
  model: string,
  lang: string | null,
): void {
  if (result.summary === null) return;
  db.prepare(
    `INSERT OR REPLACE INTO day_summaries
       (local_day, project_id, summary, input_kind, input_count, model, lang, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(day, projectId, result.summary, result.inputKind, result.inputCount, model, lang, new Date().toISOString());
}

/** Drops a stored summary, returning to the joined-titles description. */
export function clearDaySummary(db: Db, projectId: number, day: string): boolean {
  const info = db.prepare('DELETE FROM day_summaries WHERE local_day = ? AND project_id = ?').run(day, projectId);
  return info.changes > 0;
}

function clean(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

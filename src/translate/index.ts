import type OpenAI from 'openai';
import { createHash } from 'node:crypto';

import type { TraickerConfig } from '../core/config.js';
import type { Db } from '../core/db.js';
import { describeApiError, openRouter, routeToStructuredOutput, textFrom } from './client.js';

export interface TranslateResult {
  requested: number;
  fromCache: number;
  translated: number;
  failed: number;
  error: string | null;
}

/** Labels per request. Small enough to stay well inside the output cap. */
const BATCH_SIZE = 40;

/** A translation call must never hold up a report. */
const TIMEOUT_MS = 30_000;

/**
 * Sized for a batch of short labels plus whatever a reasoning model spends
 * thinking about them. Headroom rather than a tight fit: a budget that runs out
 * truncates the JSON, which fails the whole batch after the money is spent.
 */
const MAX_TOKENS = 16_384;

const SYSTEM_PROMPT = [
  'You translate short work-item labels for a freelance timesheet.',
  '',
  'Each label is the title of a unit of software work — a task name or a session summary.',
  'Return the same labels in the requested language, in the same order, one output per input.',
  '',
  'Rules:',
  '- If a label is already in the target language, return it unchanged.',
  '- Keep proper nouns, product names, file names, and technical terms as they are.',
  '- Preserve meaning and specificity. Do not summarise, expand, or editorialise.',
  '- Keep each translation about as short as its source.',
  '- These lines go on an invoice a client reads, so write them as clean prose.',
].join('\n');

/**
 * Translates labels into the target language, caching by source string.
 *
 * The cache is the reason this is safe to put behind a billing artefact: each
 * distinct label costs one call ever, and a week re-rendered next month yields
 * exactly the same words it did today. Without it, an LLM in this path would
 * make the same timesheet read differently on every run.
 *
 * Never throws. A missing API key, a rate limit, or a network failure leaves
 * the labels untranslated rather than breaking the report.
 */
export async function translateLabels(
  db: Db,
  config: TraickerConfig,
  labels: readonly string[],
  targetLang: string,
): Promise<TranslateResult> {
  const result: TranslateResult = {
    requested: 0,
    fromCache: 0,
    translated: 0,
    failed: 0,
    error: null,
  };

  const unique = [...new Set(labels.map((l) => l.trim()).filter((l) => l.length > 0))];
  result.requested = unique.length;
  if (unique.length === 0) return result;

  const cached = readCache(db, unique, targetLang);
  result.fromCache = cached.size;

  const missing = unique.filter((label) => !cached.has(label));
  if (missing.length === 0) return result;

  let client: OpenAI;
  try {
    client = openRouter(config, TIMEOUT_MS);
  } catch (error) {
    result.error = describeApiError(error);
    result.failed = missing.length;
    return result;
  }

  const insert = db.prepare(
    `INSERT OR REPLACE INTO translations (source_hash, target_lang, source_text, translated, model, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );

  for (let i = 0; i < missing.length; i += BATCH_SIZE) {
    const batch = missing.slice(i, i + BATCH_SIZE);

    let translated: string[];
    try {
      translated = await translateBatch(client, config.translationModel, batch, targetLang);
    } catch (error) {
      // Stop on the first failure rather than hammering a rate limit, and
      // report what is left untranslated instead of pretending it succeeded.
      result.error ??= describeApiError(error);
      result.failed += missing.length - i;
      break;
    }

    const now = new Date().toISOString();
    db.transaction(() => {
      batch.forEach((source, index) => {
        const value = translated[index];
        if (typeof value !== 'string' || value.trim().length === 0) return;
        insert.run(hash(source), targetLang, source, value.trim(), config.translationModel, now);
        result.translated++;
      });
    })();
  }

  return result;
}

/** Source string to translation, for labels already in the cache. */
export function readCache(db: Db, labels: readonly string[], targetLang: string): Map<string, string> {
  const found = new Map<string, string>();
  if (labels.length === 0) return found;

  const select = db.prepare(
    'SELECT source_text, translated FROM translations WHERE source_hash = ? AND target_lang = ?',
  );

  for (const label of labels) {
    const row = select.get(hash(label), targetLang) as { source_text: string; translated: string } | undefined;
    if (row) found.set(row.source_text, row.translated);
  }

  return found;
}

/**
 * One batch, with the response shape constrained by the API rather than by
 * asking politely for JSON — a parse failure here would silently drop a day's
 * description.
 */
async function translateBatch(
  client: OpenAI,
  model: string,
  batch: readonly string[],
  targetLang: string,
): Promise<string[]> {
  const completion = await client.chat.completions.create(
    routeToStructuredOutput({
      model,
      max_tokens: MAX_TOKENS,
      // Deterministic wording matters more here than variety: the cache is keyed
      // by source string, and a label re-translated after a cache clear should
      // come back reading the same way.
      temperature: 0,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'translations',
          strict: true,
          schema: {
            type: 'object',
            properties: {
              translations: {
                type: 'array',
                items: { type: 'string' },
                description: 'One translation per input label, in the same order.',
              },
            },
            required: ['translations'],
            additionalProperties: false,
          },
        },
      },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            `Target language: ${targetLang}`,
            '',
            'Labels:',
            ...batch.map((label, index) => `${index + 1}. ${label}`),
          ].join('\n'),
        },
      ],
    }),
  );

  let parsed: { translations?: unknown };
  try {
    parsed = JSON.parse(textFrom(completion)) as { translations?: unknown };
  } catch {
    // Not every provider behind a model honours `response_format`. A batch has
    // to come back as an aligned array, so unlike a single description there is
    // nothing here to salvage — but a JSON parser's complaint is not a useful
    // thing to put in front of anyone.
    throw new Error('the model answered in prose instead of the requested JSON');
  }

  if (!Array.isArray(parsed.translations)) throw new Error('response did not contain a translations array');

  // A short response would silently misalign every later label with the wrong
  // source, so treat a length mismatch as a failed batch.
  if (parsed.translations.length !== batch.length) {
    throw new Error(`expected ${batch.length} translations, got ${parsed.translations.length}`);
  }

  return parsed.translations.map((value) => (typeof value === 'string' ? value : ''));
}

function hash(source: string): string {
  return createHash('sha1').update(source).digest('hex');
}

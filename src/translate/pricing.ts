import type OpenAI from 'openai';

import type { TraickerConfig } from '../core/config.js';
import { describeApiError, openRouter, routeToStructuredOutput, textFrom } from './client.js';

export interface PricingLookupResult {
  found: boolean;
  inputPerMillion: number | null;
  outputPerMillion: number | null;
  cacheWritePerMillion: number | null;
  cacheReadPerMillion: number | null;
  /** What the model says it read this off, if anything — shown so a wrong number is easy to distrust. */
  sourceUrl: string | null;
  /** One sentence either way: what was found and where, or why it couldn't be confirmed. */
  note: string;
  /** Set only on a transport/API failure — distinct from `found: false`, which is a legitimate answer. */
  error: string | null;
}

const TIMEOUT_MS = 60_000;
const MAX_TOKENS = 2_048;

const SYSTEM_PROMPT = [
  'You look up the official API pricing of one AI model, for someone estimating their own usage cost.',
  '',
  'You have a web search tool. Use it. Do not answer from memory — pricing changes over time and a',
  'training-data answer is exactly the kind of stale number this lookup exists to avoid.',
  '',
  'Search for the price the model\'s own provider charges per API call, in USD per million tokens:',
  'input tokens, output tokens, and — if the model supports prompt caching — the cache write and cache',
  'read rates. Prefer the provider\'s own pricing page. openrouter.ai/models is an acceptable secondary',
  'source when it lists the same model. A price aggregator or a blog post repeating a number without a',
  'primary source is not enough to set found: true.',
  '',
  'The model name you are given is an internal identifier a coding tool reports (e.g. from an API',
  '`model` field) — it may need light translation to the name the provider markets it under.',
  '',
  'If you cannot find and confirm both an input and an output rate for this exact model, set found:',
  'false and leave the numbers null — do not guess, and do not substitute a similar model\'s price.',
  'Cache rates may be null on their own even when found is true: not every model caches, and it is',
  'safer to leave a rate unconfirmed than to invent one.',
].join('\n');

const SCHEMA = {
  type: 'object',
  properties: {
    found: {
      type: 'boolean',
      description: 'true only if you confirmed both an input and an output rate from a real source.',
    },
    inputPerMillion: { type: ['number', 'null'], description: 'USD per million input tokens, or null.' },
    outputPerMillion: { type: ['number', 'null'], description: 'USD per million output tokens, or null.' },
    cacheWritePerMillion: { type: ['number', 'null'], description: 'USD per million cache-write tokens, or null.' },
    cacheReadPerMillion: { type: ['number', 'null'], description: 'USD per million cache-read tokens, or null.' },
    sourceUrl: { type: ['string', 'null'], description: 'The page the numbers came from, or null.' },
    note: { type: 'string', description: 'One short sentence: what you found and where, or why you could not.' },
  },
  required: [
    'found',
    'inputPerMillion',
    'outputPerMillion',
    'cacheWritePerMillion',
    'cacheReadPerMillion',
    'sourceUrl',
    'note',
  ],
  additionalProperties: false,
} as const;

/**
 * Asks an OpenRouter model, with web search grounding, for one model's current
 * per-million-token pricing.
 *
 * Reuses `translationModel` rather than adding a second model setting: this
 * runs rarely (once per model, mostly), so the cost difference from a
 * dedicated model does not justify one more thing to configure. The `web`
 * plugin works on top of whatever model is routed to, so the existing setting
 * is enough to make the lookup grounded rather than recalled from training.
 *
 * Never throws — a missing key, a network failure, or a model that could not
 * confirm a price all come back as a result with `found: false` (or `error`
 * set, for the transport case), not an exception. Nothing is written to disk
 * here; the caller decides whether the result is trustworthy enough to save.
 */
export async function lookupModelPricing(config: TraickerConfig, model: string): Promise<PricingLookupResult> {
  const result: PricingLookupResult = {
    found: false,
    inputPerMillion: null,
    outputPerMillion: null,
    cacheWritePerMillion: null,
    cacheReadPerMillion: null,
    sourceUrl: null,
    note: '',
    error: null,
  };

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
        // OpenRouter's web-search plugin, layered on top of whatever model is
        // configured — not part of the OpenAI SDK's types, same as `provider`
        // and `reasoning` in `routeToStructuredOutput`.
        plugins: [{ id: 'web', max_results: 5 }],
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'model_pricing', strict: true, schema: SCHEMA },
        },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: `Model identifier: ${model}` },
        ],
      }),
    );

    const parsed = readResult(textFrom(completion));
    if (!parsed) {
      result.error = 'the model answered in a shape this could not read';
      return result;
    }

    return { ...parsed, error: null };
  } catch (error) {
    result.error = describeApiError(error);
    return result;
  }
}

function readResult(text: string): Omit<PricingLookupResult, 'error'> | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text.trim());
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const p = raw as Record<string, unknown>;

  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
  const str = (v: unknown): string | null => (typeof v === 'string' && v.trim().length > 0 ? v.trim() : null);

  const inputPerMillion = num(p['inputPerMillion']);
  const outputPerMillion = num(p['outputPerMillion']);
  // found is trusted only alongside both rates it claims to have confirmed —
  // a model answering found:true with a null input rate is a contradiction,
  // not a partial success worth surfacing as one.
  const found = p['found'] === true && inputPerMillion !== null && outputPerMillion !== null;

  return {
    found,
    inputPerMillion: found ? inputPerMillion : null,
    outputPerMillion: found ? outputPerMillion : null,
    cacheWritePerMillion: found ? num(p['cacheWritePerMillion']) : null,
    cacheReadPerMillion: found ? num(p['cacheReadPerMillion']) : null,
    sourceUrl: str(p['sourceUrl']),
    note: str(p['note']) ?? (found ? 'Found, no further detail.' : 'Could not confirm a price for this model.'),
  };
}

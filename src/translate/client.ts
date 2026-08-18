import OpenAI from 'openai';
import path from 'node:path';

import { dataDir, type TraickerConfig } from '../core/config.js';

/**
 * OpenRouter, reached through the OpenAI-compatible client.
 *
 * OpenRouter exposes only `POST /api/v1/chat/completions` — there is no
 * Anthropic Messages endpoint behind it — so the request shape is OpenAI's
 * even when the model being routed to is a Claude one.
 */
export function openRouter(config: TraickerConfig, timeoutMs: number): OpenAI {
  const apiKey = process.env['OPENROUTER_API_KEY'];
  if (!apiKey || apiKey.trim().length === 0) {
    // Thrown rather than returned so both call sites report it through the
    // same path as any other failure, and neither has a half-built client.
    throw new MissingCredentials();
  }

  return new OpenAI({
    apiKey,
    baseURL: config.llmBaseUrl,
    timeout: timeoutMs,
    // Optional attribution headers OpenRouter documents. Harmless, and they
    // make a request identifiable in the dashboard when a bill looks wrong.
    defaultHeaders: { 'HTTP-Referer': 'https://github.com/traicker', 'X-Title': 'trAIcker' },
  });
}

export class MissingCredentials extends Error {
  constructor() {
    // Names the file, because "set OPENROUTER_API_KEY" is only actionable if
    // you already know trAIcker reads one — and an env var exported in one
    // shell will not be there for the server you started in another.
    super(
      `No OpenRouter key found. Put it in ${path.join(dataDir(), '.env')} as\n` +
        '  OPENROUTER_API_KEY=sk-or-v1-...\n' +
        'or export it before starting traicker. Get a key at https://openrouter.ai/keys.',
    );
    this.name = 'MissingCredentials';
  }
}

/**
 * Adds OpenRouter's routing preferences to a request, and turns reasoning off.
 *
 * The same model is served by several providers, and only some of them honour
 * `response_format`. Without `require_parameters` the request can be routed to
 * one that ignores it and answers in prose, which fails at `JSON.parse` after
 * the money is already spent.
 *
 * Both call sites are mechanical judgement calls — what to leave out of a
 * line, how to phrase a translation — that do not improve with a chain of
 * thought; thinking here only competes with the answer for the token budget,
 * and on a big day it sometimes wins, truncating the JSON before it closes.
 * The OpenAI-compatible `reasoning_effort` field looked like the way to turn
 * that off, but OpenRouter does not document it as an alias for its own
 * `reasoning` param, and providers were free to read it as "think a little"
 * rather than "don't think" — which is exactly the flakiness this caused.
 * `reasoning: { effort: 'none' }` is OpenRouter's own documented switch and
 * fully skips reasoning tokens on models where reasoning is optional.
 *
 * `provider` and `reasoning` are OpenRouter extensions the OpenAI types do
 * not model, so the cast lives here — once, named — rather than at each call
 * site.
 */
export function routeToStructuredOutput<T extends object>(params: T): T {
  return {
    ...params,
    provider: { require_parameters: true },
    reasoning: { effort: 'none' },
  } as T;
}

/**
 * Turns an SDK error into one line, branching on the typed classes rather than
 * on message text.
 *
 * Ordered most-specific first. `APIConnectionError` must precede `APIError`
 * because it is a subclass of it in this SDK, so the general case would
 * otherwise swallow the network case and report a status that does not exist.
 */
export function describeApiError(error: unknown): string {
  if (error instanceof MissingCredentials) return error.message;

  if (error instanceof OpenAI.AuthenticationError) {
    return 'OpenRouter rejected the key — check OPENROUTER_API_KEY at https://openrouter.ai/keys.';
  }
  if (error instanceof OpenAI.PermissionDeniedError) {
    return 'OpenRouter refused this model — the key may lack credit or access to it.';
  }
  if (error instanceof OpenAI.NotFoundError) {
    return 'OpenRouter does not know that model. Check translationModel against https://openrouter.ai/models.';
  }
  if (error instanceof OpenAI.RateLimitError) return 'rate limited by OpenRouter';
  if (error instanceof OpenAI.APIConnectionError) return 'could not reach OpenRouter';
  if (error instanceof OpenAI.APIError) return `OpenRouter error ${error.status ?? '?'}: ${error.message}`;

  return error instanceof Error ? error.message : String(error);
}

/**
 * Reads the single text choice, failing loudly on the shapes that are easy to
 * mistake for success.
 *
 * OpenRouter forwards upstream errors in the body of a 200 response, so a
 * request can succeed at the HTTP layer and still carry nothing usable.
 */
export function textFrom(completion: OpenAI.Chat.ChatCompletion): string {
  const upstream = (completion as { error?: { message?: string } }).error;
  if (upstream?.message) throw new Error(`OpenRouter: ${upstream.message}`);

  const choice = completion.choices?.[0];
  if (!choice) throw new Error('no choices in the response');

  if (choice.finish_reason === 'length') {
    // Truncated JSON parses as a syntax error further down, which reads as a
    // bug in the schema rather than as an output cap that needs raising.
    throw new Error('the response hit the token limit before the JSON closed');
  }

  const content = choice.message?.content;
  if (typeof content !== 'string' || content.trim().length === 0) {
    throw new Error('no text content in the response');
  }
  return content;
}

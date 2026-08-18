import { describe, expect, it } from 'vitest';

import { readDescription } from '../src/translate/summarize.js';

/**
 * OpenRouter routes one model across several providers, and they do not all
 * honour `response_format` — even with `require_parameters` set. The same
 * request came back wrapped five times and bare the sixth, and the bare one
 * showed a JSON parser's complaint to someone who had pressed "redo".
 */
describe('readDescription', () => {
  it('reads the wrapped form', () => {
    expect(readDescription('{"description": "Set up the deployment pipeline."}')).toBe(
      'Set up the deployment pipeline.',
    );
  });

  it('salvages a bare line, which is the string wanted anyway', () => {
    expect(readDescription('Set up a fresh project and configured previews.')).toBe(
      'Set up a fresh project and configured previews.',
    );
  });

  it('collapses whitespace in either form', () => {
    expect(readDescription('  Set up   the\npipeline.  ')).toBe('Set up the pipeline.');
    // The tab is escaped: a raw control character inside a JSON string is
    // invalid JSON, and that case belongs with the broken-object tests.
    expect(readDescription('{"description": "Set  up\\tthe pipeline."}')).toBe('Set up the pipeline.');
  });

  it('returns empty for an empty description rather than inventing one', () => {
    expect(readDescription('{"description": ""}')).toBe('');
    expect(readDescription('   ')).toBe('');
  });

  it('refuses a broken JSON object instead of storing its source text', () => {
    // Truncated output is a different failure, and pasting the fragment onto an
    // invoice would be worse than reporting nothing.
    expect(readDescription('{"description": "Set up the dep')).toBe('');
    expect(readDescription('[{"description": "x"}')).toBe('');
  });

  it('salvages prose longer than the target line but within the storage ceiling', () => {
    // The model is asked to stay near 220 characters but often overshoots —
    // storage now keeps the full answer (clamped, expandable, in the
    // dashboard) instead of discarding anything past the target length.
    expect(readDescription('x'.repeat(1000))).toBe('x'.repeat(1000));
  });

  it('refuses prose far past the storage ceiling — a runaway response, not an overshoot', () => {
    expect(readDescription('x'.repeat(5000))).toBe('');
  });

  it('returns empty when the schema came back without the field', () => {
    expect(readDescription('{"summary": "wrong key"}')).toBe('');
  });
});

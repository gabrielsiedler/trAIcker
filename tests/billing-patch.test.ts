import { describe, expect, it } from 'vitest';

import type { BillingConfig } from '../src/core/config.js';
import { parseBillingBody } from '../src/server/app.js';

const ON_DISK: BillingConfig = {
  basis: 'occupancy',
  roundToMinutes: 15,
  weekStartsOn: 'monday',
  allowExcerpts: false,
  translateTo: 'English',
};

/** What the dashboard's form renders — note the absent `translateTo`. */
const FROM_FORM = {
  basis: 'occupancy',
  roundToMinutes: 15,
  weekStartsOn: 'monday',
  allowExcerpts: false,
};

/**
 * A settings save must not delete what its form cannot show.
 *
 * This one is not hypothetical: the handler rebuilt the billing block from a
 * whitelist of four fields, so changing a project's colour silently dropped
 * `translateTo` — the rule that keeps an hourly client's timesheet in English —
 * and the next generated line came back in Portuguese with nothing to explain
 * why.
 */
describe('parseBillingBody', () => {
  it('keeps a field the form never sent', () => {
    const result = parseBillingBody(FROM_FORM, ON_DISK);
    expect(result?.translateTo).toBe('English');
  });

  it('keeps an unknown field written by hand', () => {
    const handWritten = { ...ON_DISK, futureOption: 'keep me' } as BillingConfig;
    const result = parseBillingBody(FROM_FORM, handWritten) as unknown as Record<string, unknown>;
    expect(result['futureOption']).toBe('keep me');
  });

  it('still applies the fields the form does own', () => {
    const result = parseBillingBody({ ...FROM_FORM, basis: 'focus', roundToMinutes: 30 }, ON_DISK);
    expect(result?.basis).toBe('focus');
    expect(result?.roundToMinutes).toBe(30);
    expect(result?.translateTo).toBe('English');
  });

  it('lets an explicit null clear the translation target', () => {
    const result = parseBillingBody({ ...FROM_FORM, translateTo: null }, ON_DISK);
    expect(result?.translateTo).toBeUndefined();
  });

  it('accepts a new translation target', () => {
    const result = parseBillingBody({ ...FROM_FORM, translateTo: ' Spanish ' }, ON_DISK);
    expect(result?.translateTo).toBe('Spanish');
  });

  it('removes the whole block on null, which is how a timesheet is turned off', () => {
    expect(parseBillingBody(null, ON_DISK)).toBeNull();
  });

  it('works when there was nothing on disk', () => {
    const result = parseBillingBody(FROM_FORM, null);
    expect(result?.basis).toBe('occupancy');
    expect(result?.translateTo).toBeUndefined();
  });

  it('ignores a body that is not an object, rather than wiping the block', () => {
    expect(parseBillingBody('nonsense', ON_DISK)).toBeUndefined();
  });
});

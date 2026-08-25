import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { deleteModelPricingEntry, upsertModelPricingEntry } from '../src/core/config-writer.js';

let root: string;

function configFile(): string {
  return path.join(root, 'config.json');
}

function readConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(configFile(), 'utf8')) as Record<string, unknown>;
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'traicker-pricing-'));
  process.env['TRAICKER_DATA_DIR'] = root;
});

afterEach(() => {
  delete process.env['TRAICKER_DATA_DIR'];
  rmSync(root, { recursive: true, force: true });
});

describe('upsertModelPricingEntry', () => {
  it('creates modelPricing from nothing on disk', () => {
    upsertModelPricingEntry('claude-opus-5', {
      effectiveFrom: '2026-01-01',
      inputPerMillion: 15,
      outputPerMillion: 75,
    });

    const config = readConfig();
    expect(config['modelPricing']).toEqual({
      'claude-opus-5': [{ effectiveFrom: '2026-01-01', inputPerMillion: 15, outputPerMillion: 75 }],
    });
  });

  it('replaces an entry on the same day rather than duplicating it', () => {
    upsertModelPricingEntry('claude-opus-5', {
      effectiveFrom: '2026-01-01',
      inputPerMillion: 15,
      outputPerMillion: 75,
    });
    upsertModelPricingEntry('claude-opus-5', {
      effectiveFrom: '2026-01-01',
      inputPerMillion: 16,
      outputPerMillion: 80,
    });

    const config = readConfig();
    const entries = (config['modelPricing'] as Record<string, unknown>)['claude-opus-5'];
    expect(entries).toEqual([{ effectiveFrom: '2026-01-01', inputPerMillion: 16, outputPerMillion: 80 }]);
  });

  it('keeps a rate change on a different day as a second entry, sorted', () => {
    upsertModelPricingEntry('claude-opus-5', {
      effectiveFrom: '2026-06-01',
      inputPerMillion: 12,
      outputPerMillion: 60,
    });
    upsertModelPricingEntry('claude-opus-5', {
      effectiveFrom: '2026-01-01',
      inputPerMillion: 15,
      outputPerMillion: 75,
    });

    const config = readConfig();
    const entries = (config['modelPricing'] as Record<string, unknown>)['claude-opus-5'] as Array<{
      effectiveFrom: string;
    }>;
    expect(entries.map((e) => e.effectiveFrom)).toEqual(['2026-01-01', '2026-06-01']);
  });

  it('never touches an unrelated model already on disk', () => {
    writeFileSync(
      configFile(),
      JSON.stringify({
        modelPricing: { 'other-model': [{ effectiveFrom: '2026-01-01', inputPerMillion: 1, outputPerMillion: 2 }] },
      }),
    );

    upsertModelPricingEntry('claude-opus-5', {
      effectiveFrom: '2026-01-01',
      inputPerMillion: 15,
      outputPerMillion: 75,
    });

    const config = readConfig();
    const modelPricing = config['modelPricing'] as Record<string, unknown>;
    expect(modelPricing['other-model']).toEqual([{ effectiveFrom: '2026-01-01', inputPerMillion: 1, outputPerMillion: 2 }]);
    expect(modelPricing['claude-opus-5']).toBeDefined();
  });

  it('carries unrelated top-level keys through untouched', () => {
    writeFileSync(configFile(), JSON.stringify({ serverPort: 4917, _comment: 'hand-written note' }));

    upsertModelPricingEntry('claude-opus-5', {
      effectiveFrom: '2026-01-01',
      inputPerMillion: 15,
      outputPerMillion: 75,
    });

    const config = readConfig();
    expect(config['serverPort']).toBe(4917);
    expect(config['_comment']).toBe('hand-written note');
  });

  it('takes a timestamped backup before writing', () => {
    writeFileSync(configFile(), JSON.stringify({ serverPort: 4917 }));

    const backup = upsertModelPricingEntry('claude-opus-5', {
      effectiveFrom: '2026-01-01',
      inputPerMillion: 15,
      outputPerMillion: 75,
    });

    expect(backup).not.toBe('');
    expect(JSON.parse(readFileSync(backup, 'utf8'))).toEqual({ serverPort: 4917 });
  });
});

describe('deleteModelPricingEntry', () => {
  it('removes one entry and leaves the rest', () => {
    upsertModelPricingEntry('claude-opus-5', {
      effectiveFrom: '2026-01-01',
      inputPerMillion: 15,
      outputPerMillion: 75,
    });
    upsertModelPricingEntry('claude-opus-5', {
      effectiveFrom: '2026-06-01',
      inputPerMillion: 12,
      outputPerMillion: 60,
    });

    deleteModelPricingEntry('claude-opus-5', '2026-01-01');

    const config = readConfig();
    const entries = (config['modelPricing'] as Record<string, unknown>)['claude-opus-5'];
    expect(entries).toEqual([{ effectiveFrom: '2026-06-01', inputPerMillion: 12, outputPerMillion: 60 }]);
  });

  it('drops the model key entirely once its last entry is removed', () => {
    upsertModelPricingEntry('claude-opus-5', {
      effectiveFrom: '2026-01-01',
      inputPerMillion: 15,
      outputPerMillion: 75,
    });

    deleteModelPricingEntry('claude-opus-5', '2026-01-01');

    const config = readConfig();
    expect(config['modelPricing']).toEqual({});
  });

  it('is a no-op when the entry does not exist', () => {
    writeFileSync(configFile(), JSON.stringify({ serverPort: 4917 }));

    expect(() => deleteModelPricingEntry('claude-opus-5', '2026-01-01')).not.toThrow();
    const config = readConfig();
    expect(config['serverPort']).toBe(4917);
  });
});

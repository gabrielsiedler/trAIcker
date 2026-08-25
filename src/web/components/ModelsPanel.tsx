import { Fragment, useState } from 'react';

import { api, formatCost, num, todayLocal, type ModelPricingEntry, type ModelUsage } from '../api.js';

interface Props {
  models: ModelUsage[];
  /** Model names present in the range with no `modelPricing` entry. */
  unpriced: string[];
  /** Full price history per model, keyed the same way as `config.json`'s `modelPricing`. */
  pricing: Record<string, ModelPricingEntry[]>;
  /** Called after a rate is saved or removed, so the page refetches and costs recompute. */
  onChanged: () => void;
}

const TOKEN_FORMAT = new Intl.NumberFormat();

interface Draft {
  effectiveFrom: string;
  inputPerMillion: string;
  outputPerMillion: string;
  cacheWritePerMillion: string;
  cacheReadPerMillion: string;
}

function emptyDraft(): Draft {
  return {
    effectiveFrom: todayLocal(),
    inputPerMillion: '',
    outputPerMillion: '',
    cacheWritePerMillion: '',
    cacheReadPerMillion: '',
  };
}

/** `$0.15` rather than `$0.1500000001` — rates are typed or LLM-parsed floats, not fixed-point. */
function formatRate(n: number): string {
  return Number(n.toFixed(4)).toString();
}

/**
 * Token usage and estimated spend per model, over a range — and where a
 * model's rate comes from: typed in here, or found on the web by an LLM.
 *
 * Cost is recomputed at read time from whatever `modelPricing` currently
 * says, so saving a rate here takes effect on every past and future day in
 * the same click — there is nothing else to "apply".
 */
export function ModelsPanel({ models, unpriced, pricing, onChanged }: Props) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(emptyDraft());
  const [saving, setSaving] = useState(false);
  const [lookingUp, setLookingUp] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lookupNote, setLookupNote] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  if (models.length === 0) {
    return <p className="empty">No model usage recorded in this range.</p>;
  }

  const totals = totalsOf(models);
  const pricedCount = models.length - unpriced.length;

  const startEdit = (model: string) => {
    if (editing === model) {
      setEditing(null);
      return;
    }
    setEditing(model);
    setDraft(emptyDraft());
    setError(null);
    setLookupNote(null);
  };

  const patch = (change: Partial<Draft>) => setDraft((d) => ({ ...d, ...change }));

  const save = async (model: string) => {
    const inputPerMillion = Number(draft.inputPerMillion);
    const outputPerMillion = Number(draft.outputPerMillion);
    if (
      !draft.effectiveFrom ||
      !Number.isFinite(inputPerMillion) ||
      inputPerMillion < 0 ||
      !Number.isFinite(outputPerMillion) ||
      outputPerMillion < 0
    ) {
      setError('Need a date, and input/output rates of 0 or more.');
      return;
    }

    const cacheWrite = draft.cacheWritePerMillion.trim().length > 0 ? Number(draft.cacheWritePerMillion) : undefined;
    const cacheRead = draft.cacheReadPerMillion.trim().length > 0 ? Number(draft.cacheReadPerMillion) : undefined;

    setSaving(true);
    setError(null);
    try {
      await api.saveModelPricing({
        model,
        effectiveFrom: draft.effectiveFrom,
        inputPerMillion,
        outputPerMillion,
        cacheWritePerMillion: cacheWrite !== undefined && Number.isFinite(cacheWrite) ? cacheWrite : undefined,
        cacheReadPerMillion: cacheRead !== undefined && Number.isFinite(cacheRead) ? cacheRead : undefined,
      });
      setEditing(null);
      setSaved(model);
      window.setTimeout(() => setSaved((s) => (s === model ? null : s)), 1500);
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const removeEntry = async (model: string, effectiveFrom: string) => {
    setError(null);
    try {
      await api.deleteModelPricing(model, effectiveFrom);
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  /** Asks an LLM (with web search) for the model's current rate, and fills the form — does not save on its own. */
  const lookup = async (model: string) => {
    setLookingUp(true);
    setError(null);
    setLookupNote(null);
    try {
      const result = await api.lookupModelPricing(model);
      setLookupNote(`${result.note}${result.sourceUrl ? ` — ${result.sourceUrl}` : ''}`);
      if (result.found) {
        patch({
          inputPerMillion: result.inputPerMillion !== null ? String(result.inputPerMillion) : '',
          outputPerMillion: result.outputPerMillion !== null ? String(result.outputPerMillion) : '',
          cacheWritePerMillion: result.cacheWritePerMillion !== null ? String(result.cacheWritePerMillion) : '',
          cacheReadPerMillion: result.cacheReadPerMillion !== null ? String(result.cacheReadPerMillion) : '',
        });
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLookingUp(false);
    }
  };

  return (
    <>
      {unpriced.length > 0 && (
        <div className="ts-note">
          No pricing configured for {unpriced.join(', ')} — click <strong>price…</strong> on the row below to set
          it by hand or look it up.
        </div>
      )}
      {error && <div className="error">{error}</div>}

      <div className="table-scroll">
        <table className="data mp-table">
          <thead>
            <tr>
              <th>Model</th>
              <th className="num">Turns</th>
              <th className="num">Input</th>
              <th className="num">Output</th>
              <th className="num" title="Tokens written to the prompt cache">
                Cache write
              </th>
              <th className="num" title="Tokens read from the prompt cache">
                Cache read
              </th>
              <th className="num">Est. cost</th>
              <th className="mp-col-edit" aria-label="Price" />
            </tr>
          </thead>
          <tbody>
            {models.map((m) => {
              const isEditing = editing === m.model;
              const history = [...(pricing[m.model] ?? [])].sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom));

              return (
                <Fragment key={m.model}>
                  <tr className={isEditing ? 'pp-tr-editing' : ''}>
                    <td>
                      {m.model}
                      {saved === m.model && <span className="pp-saved">saved</span>}
                    </td>
                    <td className="num muted">{m.turn_count}</td>
                    <td className="num">{TOKEN_FORMAT.format(num(m.input_tokens))}</td>
                    <td className="num">{TOKEN_FORMAT.format(num(m.output_tokens))}</td>
                    <td className="num muted">{TOKEN_FORMAT.format(num(m.cache_creation_input_tokens))}</td>
                    <td className="num muted">{TOKEN_FORMAT.format(num(m.cache_read_input_tokens))}</td>
                    <td
                      className={`num ${m.cost_usd === null ? 'muted' : 'billable'}`}
                      title={
                        m.partiallyPriced
                          ? 'Only part of this range had a price in effect — this estimate covers less than the full range.'
                          : undefined
                      }
                    >
                      {formatCost(m.cost_usd)}
                      {m.partiallyPriced && <span className="ts-src">partial</span>}
                    </td>
                    <td className="mp-col-edit">
                      <button onClick={() => startEdit(m.model)}>{isEditing ? 'close' : 'price…'}</button>
                    </td>
                  </tr>

                  {isEditing && (
                    <tr className="pp-tr-edit-row">
                      <td colSpan={8}>
                        <div className="pp-edit">
                          {history.length > 0 && (
                            <div className="mp-history">
                              {history.map((h) => (
                                <span className="pp-tag mp-rate" key={h.effectiveFrom}>
                                  since {h.effectiveFrom}: ${formatRate(h.inputPerMillion)}/${formatRate(h.outputPerMillion)}
                                  {' per M'}
                                  <button
                                    type="button"
                                    className="mp-remove"
                                    aria-label={`Remove the rate effective ${h.effectiveFrom}`}
                                    onClick={() => void removeEntry(m.model, h.effectiveFrom)}
                                  >
                                    ×
                                  </button>
                                </span>
                              ))}
                            </div>
                          )}

                          <div className="pp-fields">
                            <label>
                              Effective from
                              <input
                                type="date"
                                value={draft.effectiveFrom}
                                onChange={(e) => patch({ effectiveFrom: e.target.value })}
                              />
                            </label>
                            <label>
                              Input $/M tokens
                              <input
                                type="number"
                                min="0"
                                step="0.001"
                                value={draft.inputPerMillion}
                                onChange={(e) => patch({ inputPerMillion: e.target.value })}
                              />
                            </label>
                            <label>
                              Output $/M tokens
                              <input
                                type="number"
                                min="0"
                                step="0.001"
                                value={draft.outputPerMillion}
                                onChange={(e) => patch({ outputPerMillion: e.target.value })}
                              />
                            </label>
                            <label>
                              Cache write $/M (optional)
                              <input
                                type="number"
                                min="0"
                                step="0.001"
                                value={draft.cacheWritePerMillion}
                                onChange={(e) => patch({ cacheWritePerMillion: e.target.value })}
                              />
                            </label>
                            <label>
                              Cache read $/M (optional)
                              <input
                                type="number"
                                min="0"
                                step="0.001"
                                value={draft.cacheReadPerMillion}
                                onChange={(e) => patch({ cacheReadPerMillion: e.target.value })}
                              />
                            </label>
                          </div>

                          <div className="pp-actions">
                            <button className="pp-save" disabled={saving} onClick={() => void save(m.model)}>
                              {saving ? 'Saving…' : 'Save to config.json'}
                            </button>
                            <button type="button" disabled={lookingUp} onClick={() => void lookup(m.model)}>
                              {lookingUp ? 'Searching the web…' : 'Find it for me (LLM)'}
                            </button>
                            <button type="button" onClick={() => setEditing(null)}>
                              Cancel
                            </button>
                          </div>
                          {lookingUp && (
                            <div className="ts-note">Asking the model to search for this rate — up to a minute…</div>
                          )}
                          {lookupNote && !lookingUp && <div className="ts-note">{lookupNote}</div>}
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="total-all">
              <td>
                All models
                {pricedCount < models.length && (
                  <span className="total-note" title="Models with no pricing entry are excluded from this total">
                    {pricedCount}/{models.length} priced
                  </span>
                )}
              </td>
              <td className="num muted">{totals.turns}</td>
              <td className="num">{TOKEN_FORMAT.format(totals.input)}</td>
              <td className="num">{TOKEN_FORMAT.format(totals.output)}</td>
              <td className="num muted">{TOKEN_FORMAT.format(totals.cacheWrite)}</td>
              <td className="num muted">{TOKEN_FORMAT.format(totals.cacheRead)}</td>
              <td className="num billable">{formatCost(totals.cost)}</td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
    </>
  );
}

interface Totals {
  turns: number;
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  cost: number;
}

function totalsOf(rows: readonly ModelUsage[]): Totals {
  return {
    turns: rows.reduce((s, m) => s + num(m.turn_count), 0),
    input: rows.reduce((s, m) => s + num(m.input_tokens), 0),
    output: rows.reduce((s, m) => s + num(m.output_tokens), 0),
    cacheWrite: rows.reduce((s, m) => s + num(m.cache_creation_input_tokens), 0),
    cacheRead: rows.reduce((s, m) => s + num(m.cache_read_input_tokens), 0),
    // Priced models only — an unpriced model's real cost is unknown, not $0,
    // so it must not silently drag the visible total down.
    cost: rows.reduce((s, m) => s + (m.cost_usd ?? 0), 0),
  };
}

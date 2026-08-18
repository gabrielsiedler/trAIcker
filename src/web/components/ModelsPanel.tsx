import { formatCost, num, type ModelUsage } from '../api.js';

interface Props {
  models: ModelUsage[];
  /** Model names present in the range with no `modelPricing` entry. */
  unpriced: string[];
}

const TOKEN_FORMAT = new Intl.NumberFormat();

/**
 * Token usage and estimated spend per model.
 *
 * An estimate, not a bill: cost is recomputed at read time from whatever
 * `modelPricing` currently says, so it is only as accurate as that config —
 * which is why a model with no entry shows "—" rather than a misleading $0.
 */
export function ModelsPanel({ models, unpriced }: Props) {
  if (models.length === 0) {
    return <p className="empty">No model usage recorded in this range.</p>;
  }

  const totals = totalsOf(models);
  const pricedCount = models.length - unpriced.length;

  return (
    <>
      {unpriced.length > 0 && (
        <div className="ts-note">
          No pricing configured for {unpriced.join(', ')} — add a <code>modelPricing</code> entry in{' '}
          <code>~/.traicker/config.json</code> to estimate its cost.
        </div>
      )}

      <table className="data">
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
          </tr>
        </thead>
        <tbody>
          {models.map((m) => (
            <tr key={m.model}>
              <td>{m.model}</td>
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
            </tr>
          ))}
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
          </tr>
        </tfoot>
      </table>
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

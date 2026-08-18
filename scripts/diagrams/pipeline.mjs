// Generates docs/images/pipeline.svg
import { writeFileSync } from 'node:fs'

const C = {
  bg: '#0d1117', panel: '#161b22', border: '#262d36',
  text: '#e6edf3', muted: '#8b949e', dim: '#6e7781',
  focus: '#58a6ff', agent: '#d29922', occ: '#3fb950', steel: '#4d5866',
}
const FONT = "ui-sans-serif, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
const MONO = "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace"

const stages = [
  { title: 'Claude Code hook', sub: '10 hook events', accent: C.focus, notes: ['~1 ms of work', 'always exits 0'] },
  { title: 'NDJSON spool', sub: '~/.traicker/spool', accent: C.steel, notes: ['one file per session', 'O_APPEND, atomic'] },
  { title: 'SQLite', sub: 'events', accent: C.steel, notes: ['append-only', 'UNIQUE content hash'] },
  { title: 'Spans', sub: 'focus · agent', accent: C.agent, notes: ['derived, never stored raw', 'rebuilt per day'] },
  { title: 'Reports', sub: 'CLI · dashboard', accent: C.occ, notes: ['occupancy · timesheet', 'refreshed on read'] },
]

const W = 880, BW = 148, BH = 66, GAP = 25, X = 20, BY = 74
const H = 226
const bx = (i) => X + i * (BW + GAP)

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
const o = []
const P = (s) => o.push(s)
const text = (tx, ty, s, { size = 11, fill = C.muted, anchor = 'middle', weight = 400, font = FONT } = {}) =>
  P('<text x="' + tx.toFixed(1) + '" y="' + ty + '" font-family="' + font + '" font-size="' + size +
    '" font-weight="' + weight + '" fill="' + fill + '" text-anchor="' + anchor + '">' + esc(s) + '</text>')

P('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H +
  '" role="img" aria-label="Pipeline: Claude Code hook appends to an NDJSON spool, which is ingested into an append-only SQLite event log, from which spans and reports are derived.">')
P('<rect width="' + W + '" height="' + H + '" rx="12" fill="' + C.bg + '"/>')
P('<rect x="0.5" y="0.5" width="' + (W - 1) + '" height="' + (H - 1) + '" rx="12" fill="none" stroke="' + C.border + '"/>')

text(20, 34, 'How a prompt becomes a billable minute', { size: 14, fill: C.text, weight: 600, anchor: 'start' })
text(W - 20, 34, 'nothing on this path can block your prompt', { size: 11, fill: C.dim, anchor: 'end' })

for (let i = 0; i < stages.length; i++) {
  const s = stages[i], x = bx(i)
  P('<rect x="' + x + '" y="' + BY + '" width="' + BW + '" height="' + BH + '" rx="8" fill="' + C.panel +
    '" stroke="' + C.border + '"/>')
  P('<rect x="' + x + '" y="' + BY + '" width="3.5" height="' + BH + '" rx="1.75" fill="' + s.accent + '"/>')
  text(x + BW / 2 + 2, BY + 28, s.title, { size: 12.5, fill: C.text, weight: 600 })
  text(x + BW / 2 + 2, BY + 46, s.sub, { size: 10, fill: C.dim, font: MONO })
  s.notes.forEach((n, k) => text(x + BW / 2, BY + BH + 24 + k * 15, n, { size: 9.5, fill: C.muted }))

  if (i < stages.length - 1) {
    const ax = x + BW + 6, ay = BY + BH / 2
    P('<line x1="' + ax + '" y1="' + ay + '" x2="' + (ax + GAP - 17) + '" y2="' + ay + '" stroke="' + C.border + '" stroke-width="1.5"/>')
    P('<path d="M' + (ax + GAP - 17) + ' ' + (ay - 4) + ' L' + (ax + GAP - 11) + ' ' + ay + ' L' + (ax + GAP - 17) + ' ' + (ay + 4) + 'Z" fill="' + C.border + '"/>')
  }
}

P('<line x1="20" y1="' + (H - 44) + '" x2="' + (W - 20) + '" y2="' + (H - 44) + '" stroke="' + C.border + '" stroke-opacity="0.7"/>')
text(W / 2, H - 22, 'Ingestion reads only complete lines and tracks a byte offset per file; aggregation is a pure function of the event log. Run any of it as many times as you like.',
  { size: 10.5, fill: C.muted })
P('</svg>')

writeFileSync('docs/images/pipeline.svg', o.join('\n') + '\n')
console.log('wrote docs/images/pipeline.svg')

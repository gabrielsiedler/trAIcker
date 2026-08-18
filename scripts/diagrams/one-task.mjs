// Generates docs/images/one-task.svg, the single-task case the billing
// argument turns on: half an hour of orchestration, two hours of execution.
// Run from the repository root.
import { writeFileSync } from 'node:fs'

const C = {
  bg: '#0d1117', border: '#262d36', grid: '#ffffff',
  text: '#e6edf3', muted: '#8b949e', dim: '#6e7781',
  focus: '#58a6ff', agent: '#d29922', occ: '#3fb950',
}
const FONT = "ui-sans-serif, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"

const SPAN = 168                 // minutes drawn
const FOCUS = [0, 30]            // you: planning, prompting, correcting
const AGENT = [30, 150]          // the run you dispatched and answer for
const OCC = [0, 150]             // union of the two

const W = 880, X0 = 156, X1 = 856
const x = (m) => X0 + (m / SPAN) * (X1 - X0)
const rows = [
  { y: 84, h: 15, bar: FOCUS, fill: C.focus, label: 'you', note: '0h30', caption: 'planning, prompting, correcting' },
  { y: 118, h: 15, bar: AGENT, fill: C.agent, label: 'agents', note: '2h00', caption: 'execution you are answerable for' },
  { y: 152, h: 17, bar: OCC, fill: C.occ, label: 'billed', note: '2h30', caption: 'occupancy (one continuous stretch of work)' },
]
const H = 234

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
const o = []
const P = (s) => o.push(s)
const text = (tx, ty, s, { size = 11, fill = C.muted, anchor = 'start', weight = 400 } = {}) =>
  P('<text x="' + tx.toFixed(1) + '" y="' + ty + '" font-family="' + FONT + '" font-size="' + size +
    '" font-weight="' + weight + '" fill="' + fill + '" text-anchor="' + anchor + '">' + esc(s) + '</text>')

P('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H +
  '" role="img" aria-label="One task: half an hour of human orchestration, two hours of agent execution, and two and a half hours of occupancy billed as one continuous stretch of work.">')
P('<rect width="' + W + '" height="' + H + '" rx="12" fill="' + C.bg + '"/>')
P('<rect x="0.5" y="0.5" width="' + (W - 1) + '" height="' + (H - 1) + '" rx="12" fill="none" stroke="' + C.border + '"/>')

text(24, 34, 'One task, from the first prompt to something that works', { size: 14, fill: C.text, weight: 600 })
text(X1, 34, 'a database migration, start to finish', { size: 11, fill: C.dim, anchor: 'end' })

const TOP = 66, BOTTOM = 178
for (let m = 0; m <= 120; m += 60) {
  P('<line x1="' + x(m).toFixed(1) + '" y1="' + TOP + '" x2="' + x(m).toFixed(1) + '" y2="' + BOTTOM +
    '" stroke="' + C.grid + '" stroke-opacity="0.07"/>')
  text(x(m), 58, m === 0 ? 'start' : '+' + (m / 60) + ' h', { size: 10, fill: C.dim, anchor: m === 0 ? 'start' : 'middle' })
}

for (const r of rows) {
  const [a, b] = r.bar, w = x(b) - x(a)
  text(X0 - 16, r.y + r.h - 3, r.label, { size: 12, fill: C.text, anchor: 'end', weight: 500 })
  P('<rect x="' + x(a).toFixed(1) + '" y="' + r.y + '" width="' + w.toFixed(1) + '" height="' + r.h +
    '" rx="3" fill="' + r.fill + '" opacity="0.9"/>')
  if (w > 200) {
    text(x(a) + 12, r.y + r.h - 4, r.caption, { size: 10.5, fill: C.bg, weight: 500 })
    text(x(b) - 12, r.y + r.h - 4, r.note, { size: 11, fill: C.bg, anchor: 'end', weight: 700 })
  } else {
    text(x(b) - 12, r.y + r.h - 4, r.note, { size: 11, fill: C.bg, anchor: 'end', weight: 700 })
    text(x(b) + 14, r.y + r.h - 4, r.caption, { size: 10.5, fill: C.dim })
  }
}

P('<line x1="24" y1="' + (H - 44) + '" x2="' + (W - 24) + '" y2="' + (H - 44) + '" stroke="' + C.border + '" stroke-opacity="0.7"/>')
P('<text x="24" y="' + (H - 22) + '" font-family="' + FONT + '" font-size="11.5" fill="' + C.muted + '">' +
  'The half hour is what made the two hours worth having. Bill the half hour alone, and ' +
  '<tspan fill="' + C.text + '" font-weight="700">the better you get at this, the less you earn.</tspan></text>')
P('</svg>')

writeFileSync('docs/images/one-task.svg', o.join('\n') + '\n')
console.log('wrote docs/images/one-task.svg')

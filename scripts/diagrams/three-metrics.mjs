// Generates docs/images/three-metrics.svg
// Coordinates are derived by running trAIcker's own rules over a synthetic
// afternoon, so the picture cannot contradict the algorithm it illustrates.
import { writeFileSync } from 'node:fs'

const IDLE = 15        // idleTimeoutMinutes
const STITCH = 10      // stitchGapMinutes

const C = {
  bg: '#0d1117', border: '#262d36', grid: '#ffffff',
  text: '#e6edf3', muted: '#8b949e', dim: '#6e7781',
  focus: '#58a6ff', agent: '#d29922', occ: '#3fb950',
}
const FONT = "ui-sans-serif, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"

const projects = [
  { key: 'acme', name: 'Acme Payments' },
  { key: 'northwind', name: 'Northwind CRM' },
  { key: 'helio', name: 'Helio' },
]

// minutes after 13:00
const prompts = [
  [0, 'acme'], [12, 'acme'], [25, 'northwind'], [33, 'northwind'], [40, 'acme'], [48, 'helio'],
  [60, 'helio'], [72, 'acme'], [85, 'northwind'], [95, 'northwind'], [110, 'helio'], [118, 'acme'],
  [130, 'acme'], [145, 'northwind'],
  [185, 'helio'], [195, 'helio'], [205, 'acme'], [215, 'northwind'], [230, 'acme'], [245, 'acme'],
  [258, 'northwind'], [270, 'helio'], [282, 'acme'],
]
const LAST_TURN_END = 290

const agents = {
  acme: [[14, 46], [26, 52], [120, 150], [132, 172], [240, 272]],
  northwind: [[35, 75], [88, 128], [100, 118], [220, 252]],
  helio: [[52, 92], [62, 80], [190, 222], [274, 294]],
}

// --- focus: [prompt_i, next prompt anywhere), dropped when the gap exceeds idle
const focus = Object.fromEntries(projects.map(p => [p.key, []]))
for (let i = 0; i < prompts.length; i++) {
  const [t, k] = prompts[i]
  const next = i + 1 < prompts.length ? prompts[i + 1][0] : LAST_TURN_END
  if (next - t > IDLE) continue          // away, not idle: discarded
  focus[k].push([t, next])
}
const merge = (iv) => {
  const s = [...iv].sort((a, b) => a[0] - b[0]); const out = []
  for (const [a, b] of s) {
    const last = out[out.length - 1]
    if (last && a <= last[1]) last[1] = Math.max(last[1], b); else out.push([a, b])
  }
  return out
}
for (const k of Object.keys(focus)) focus[k] = merge(focus[k])

// --- agent lanes (greedy by start), wall-clock union and effort sum
const lanes = {}, agentWall = {}, agentEffort = {}
for (const p of projects) {
  const runs = [...agents[p.key]].sort((a, b) => a[0] - b[0])
  const ends = []
  lanes[p.key] = runs.map(([a, b]) => {
    let lane = ends.findIndex(e => e <= a)
    if (lane === -1) { lane = ends.length; ends.push(b) } else ends[lane] = b
    return [a, b, lane]
  })
  agentWall[p.key] = merge(runs).reduce((n, [a, b]) => n + b - a, 0)
  agentEffort[p.key] = runs.reduce((n, [a, b]) => n + b - a, 0)
}

// --- occupancy: union(focus, agent), gaps <= stitch bridged (bridges drawn faded)
const occ = {}
for (const p of projects) {
  const u = merge([...focus[p.key], ...agents[p.key]])
  const parts = []
  for (let i = 0; i < u.length; i++) {
    parts.push({ s: u[i][0], e: u[i][1], bridge: false })
    if (i + 1 < u.length && u[i + 1][0] - u[i][1] <= STITCH)
      parts.push({ s: u[i][1], e: u[i + 1][0], bridge: true })
  }
  occ[p.key] = parts
}

const sum = (iv) => iv.reduce((n, x) => n + (x.e ?? x[1]) - (x.s ?? x[0]), 0)
const hm = (m) => Math.floor(m / 60) + 'h' + String(m % 60).padStart(2, '0')

const T = {
  focus: sum(projects.flatMap(p => focus[p.key])),
  wall: projects.reduce((n, p) => n + agentWall[p.key], 0),
  effort: projects.reduce((n, p) => n + agentEffort[p.key], 0),
  occ: projects.reduce((n, p) => n + sum(occ[p.key]), 0),
}
console.log('per project:')
for (const p of projects) console.log(' ', p.name.padEnd(15),
  'focus', hm(sum(focus[p.key])), '| agent', hm(agentWall[p.key]), 'wall /', hm(agentEffort[p.key]), 'effort',
  '| occupancy', hm(sum(occ[p.key])), '| lanes', Math.max(...lanes[p.key].map(l => l[2])) + 1)
console.log('totals:', Object.fromEntries(Object.entries(T).map(([k, v]) => [k, hm(v)])))

// ---------- render ----------
const W = 880, X0 = 148, X1 = 856, SPAN = 300
const x = (m) => X0 + (m / SPAN) * (X1 - X0)
const AXIS_Y = 56, PLOT_TOP = 74, GH = 96
const gy = (i) => PLOT_TOP + 16 + i * GH
const PLOT_BOTTOM = gy(2) + 78
const LY = PLOT_BOTTOM + 32
const H = LY + 46

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
const o = []
const P = (s) => o.push(s)
const text = (tx, ty, s, { size = 11, fill = C.muted, anchor = 'start', weight = 400 } = {}) =>
  P('<text x="' + (typeof tx === 'number' ? tx.toFixed(1) : tx) + '" y="' + ty + '" font-family="' + FONT +
    '" font-size="' + size + '" font-weight="' + weight + '" fill="' + fill + '" text-anchor="' + anchor + '">' + esc(s) + '</text>')
const rect = (rx, ry, w, h, fill, { r = 2, op = 1 } = {}) =>
  P('<rect x="' + rx.toFixed(1) + '" y="' + ry + '" width="' + Math.max(w, 1.4).toFixed(1) + '" height="' + h +
    '" rx="' + r + '" fill="' + fill + '"' + (op !== 1 ? ' opacity="' + op + '"' : '') + '/>')
const line = (x1, y1, x2, y2, stroke, op, dash) =>
  P('<line x1="' + x1.toFixed(1) + '" y1="' + y1 + '" x2="' + x2.toFixed(1) + '" y2="' + y2 + '" stroke="' + stroke +
    '" stroke-opacity="' + op + '"' + (dash ? ' stroke-dasharray="' + dash + '"' : '') + '/>')

P('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H +
  '" role="img" aria-label="A single afternoon across three projects: human focus never overlaps itself, agent runs overlap freely, and occupancy is the union of the two.">')
P('<rect width="' + W + '" height="' + H + '" rx="12" fill="' + C.bg + '"/>')
P('<rect x="0.5" y="0.5" width="' + (W - 1) + '" height="' + (H - 1) + '" rx="12" fill="none" stroke="' + C.border + '"/>')

text(24, 34, 'A single afternoon, three clients, no timer started', { size: 14, fill: C.text, weight: 600 })
text(X1, 34, '13:00 to 18:00', { size: 11, fill: C.dim, anchor: 'end' })

for (let m = 0; m <= SPAN; m += 60) {
  line(x(m), PLOT_TOP, x(m), PLOT_BOTTOM, C.grid, 0.07)
  text(x(m), AXIS_Y, (13 + m / 60) + ':00', { size: 10, fill: C.dim, anchor: m === 0 ? 'start' : 'middle' })
}
// every prompt as a faint full-height rule: focus boundaries are prompt times, nothing else
for (const [t] of prompts) line(x(t), PLOT_TOP, x(t), PLOT_BOTTOM, C.grid, 0.05)

// the gap that is thrown away rather than counted
const gapA = 145, gapB = 185
P('<rect x="' + x(gapA).toFixed(1) + '" y="' + PLOT_TOP + '" width="' + (x(gapB) - x(gapA)).toFixed(1) +
  '" height="' + (PLOT_BOTTOM - PLOT_TOP) + '" fill="' + C.grid + '" fill-opacity="0.03" stroke="' + C.muted +
  '" stroke-opacity="0.3" stroke-dasharray="3 3"/>')
text((x(gapA) + x(gapB)) / 2, PLOT_TOP - 6, '40 min away, discarded', { size: 9.5, fill: C.dim, anchor: 'middle' })

for (let i = 0; i < projects.length; i++) {
  const p = projects[i], y = gy(i)
  text(X0 - 16, y + 25, p.name, { size: 12, fill: C.text, anchor: 'end', weight: 500 })
  text(X0 - 16, y + 41, hm(sum(occ[p.key])) + ' occupancy', { size: 9.5, fill: C.dim, anchor: 'end' })

  for (const [t, k] of prompts) if (k === p.key) rect(x(t) - 1, y - 2, 2, 11, C.focus, { r: 1, op: 0.85 })
  for (const [a, b] of focus[p.key]) rect(x(a), y + 13, x(b) - x(a), 11, C.focus, { r: 2 })
  for (const [a, b, lane] of lanes[p.key]) rect(x(a), y + 32 + lane * 11, x(b) - x(a), 8, C.agent, { r: 2, op: 0.9 })
  for (const s of occ[p.key]) rect(x(s.s), y + 60, x(s.e) - x(s.s), 11, C.occ, { r: 2, op: s.bridge ? 0.28 : 0.85 })

  if (i < projects.length - 1) line(24, y + 82, X1, y + 82, C.border, 0.7)
}

let lx = 24
const legend = [
  [C.focus, 'focus (you, one project at a time)', 'bar'],
  [C.agent, 'agent runs (parallel, they overlap freely)', 'bar'],
  [C.occ, 'occupancy (the union, and the billable line)', 'bar'],
  [C.focus, 'a prompt', 'tick'],
]
for (const [c, label, shape] of legend) {
  if (shape === 'tick') rect(lx + 3, LY - 10, 2, 11, c, { r: 1, op: 0.85 })
  else rect(lx, LY - 9, 10, 10, c, { r: 2 })
  text(lx + 16, LY, label, { size: 10.5, fill: C.muted })
  lx += 22 + label.length * 5.35
}
text(24, LY + 28, 'Focus ' + hm(T.focus) + '   ·   Agent ' + hm(T.wall) + ' wall-clock, ' + hm(T.effort) +
  ' of effort   ·   Occupancy ' + hm(T.occ) + ', in an afternoon five hours long.', { size: 12, fill: C.text, weight: 600 })
P('</svg>')

writeFileSync('docs/images/three-metrics.svg', o.join('\n') + '\n')
console.log('wrote docs/images/three-metrics.svg')

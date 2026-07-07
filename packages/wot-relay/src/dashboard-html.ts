// Generic broker dashboard (wot-relay). A single-file, build-step-free page served
// at `/dashboard` on EVERY broker (box, server, future). Vanilla JS + inline CSS.
//
// Design: dark, calm, Beamer- AND phone-friendly (monitor.html aesthetic as the
// base). It consumes GET `/dashboard/data`:
//   - Hero + Performance from the public aggregates (connectionCount, connectedDids,
//     logStats.{totalEntries,docCount,personalDocCount,totalLogBytes}, uptimeSeconds,
//     memoryMB).
//   - Identities / Documents / Inbox from the ALWAYS-public server-SHORTENED
//     `display` block (dids / topDocs / inboxPendingByDid) — this is the DEFAULT.
//   - Full-detail mode (RELAY_DEBUG_STATS=1, i.e. box operation) is detected ONLY
//     via the PRESENCE of the flag-gated fields (logStats.entriesByDoc /
//     queueStats.byDid). Only then do the cards render the FULL ids from the full
//     maps. The detection must NEVER key on `devicesPerDid`: that field is always
//     public (frozen harness contract) and carries full DIDs even on a prod
//     broker — preferring it would undo the shortening at the render layer.
//
// Security: `/dashboard/data` is unauthenticated + `ACAO:*`; the redaction is
// server-side (see relay.ts). This page still esc()'s EVERY interpolated string —
// including shortened/hashed ids — before it touches innerHTML (defence in depth;
// a full docId under the flag is a client-chosen string).
//
// Reactivity: one gated `tick()` fetch (`cache:no-store` + `AbortSignal.timeout`),
// polled every 2s, PAUSED while the tab is hidden; a later SSE upgrade swaps only
// the source, not the UI. On a failed/late fetch the live dot turns amber and shows
// "relay unreachable (Ns)".
//
// History: a SEPARATE, encapsulated `tickMetrics()` cycle (30s + on window switch,
// also paused while hidden) polls GET `/dashboard/metrics?window=…` and renders
// six canvas line charts (messages/errors rate, event-loop/sqlite latency, CPU
// load/temp, RAM, network rate, disk free). It never touches the live `tick()`
// logic. Metrics buckets are aggregates only (no ids); rates are derived
// client-side as counterSum / spanSeconds (the server sums byte/count deltas on
// downsampling and reports the honest span per bucket).

const DASHBOARD_CSS = `
  :root {
    --bg: #0b1220;
    --card: #111a2e;
    --card-2: #0e1728;
    --ink: #e6edf7;
    --dim: #8a97ad;
    --line: #1e2a44;
    --accent: #4f8cff;
    --good: #3ddc84;
    --warn: #ffb84f;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; background: var(--bg); color: var(--ink);
    font-family: 'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
    -webkit-font-smoothing: antialiased; }
  .wrap { max-width: 1100px; margin: 0 auto; padding: 28px 20px 48px; }

  /* Header */
  header { display: flex; align-items: baseline; justify-content: space-between;
    gap: 12px; flex-wrap: wrap; margin-bottom: 22px; }
  h1 { margin: 0; font-size: 1.55rem; letter-spacing: -.01em; display: flex; align-items: center; }
  h1 .dot { display: inline-block; width: .6em; height: .6em; border-radius: 50%;
    background: var(--good); margin-right: .45em; animation: pulse 2s infinite; }
  h1 .dot.off { background: var(--warn); animation: none; }
  @keyframes pulse { 50% { opacity: .35; } }
  .host { color: var(--ink); font-weight: 600; }
  .sub { color: var(--dim); font-size: .92rem; text-align: right; }
  .sub .offline { color: var(--warn); }

  /* Hero numbers */
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 14px; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 16px; padding: 18px 20px; }
  .label { color: var(--dim); font-size: .8rem; text-transform: uppercase; letter-spacing: .08em; margin-bottom: 8px; }
  .big { font-size: 3.4rem; font-weight: 800; line-height: 1; font-variant-numeric: tabular-nums;
    transition: color .5s ease; }
  .unit { font-size: 1rem; color: var(--dim); font-weight: 500; margin-left: .3em; }
  /* Subtle, non-bouncing pulse when a value changes. */
  .flash { animation: flash .6s ease; }
  @keyframes flash { 0% { color: var(--accent); } 100% { color: var(--ink); } }

  /* Two-column performance row */
  .row2 { display: grid; grid-template-columns: 2fr 1fr; gap: 14px; margin-top: 14px; }
  @media (max-width: 760px) { .row2 { grid-template-columns: 1fr; } }
  canvas { width: 100%; height: 120px; display: block; }
  .vitals { font-size: .92rem; }
  .vrow { display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 10px;
    margin: 10px 0; color: var(--dim); font-variant-numeric: tabular-nums; }
  .vrow code { color: var(--ink); font-family: inherit; }

  /* List cards (identities / documents / inbox) */
  .cards3 { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
    gap: 14px; margin-top: 14px; }
  .list { margin-top: 4px; }
  .lrow { display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 10px;
    margin: 9px 0; font-variant-numeric: tabular-nums; }
  .lrow .id { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .lrow code { color: var(--ink); font-family: 'SF Mono', 'Fira Code', ui-monospace, monospace;
    font-size: .86rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .lrow .meta { color: var(--dim); font-size: .86rem; white-space: nowrap; }
  .pdot { display: inline-block; width: .55em; height: .55em; border-radius: 50%; flex-shrink: 0;
    background: #33415a; }
  .pdot.on { background: var(--good); }

  /* Doc bars */
  .docrow { display: grid; grid-template-columns: 130px 1fr auto; align-items: center; gap: 10px;
    margin: 9px 0; color: var(--dim); font-variant-numeric: tabular-nums; }
  .docrow code { color: var(--ink); font-family: 'SF Mono', 'Fira Code', ui-monospace, monospace;
    font-size: .82rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bar { height: 10px; border-radius: 6px; background: var(--accent); min-width: 4px;
    transition: width .5s ease; }
  .empty { color: var(--dim); font-size: .9rem; padding: 6px 0; }

  /* History (metrics) section */
  .histhead { display: flex; align-items: center; justify-content: space-between;
    gap: 12px; flex-wrap: wrap; margin: 22px 0 12px; }
  .histhead .label { margin-bottom: 0; }
  .winbtns { display: flex; gap: 6px; }
  .winbtn { background: var(--card); border: 1px solid var(--line); color: var(--dim);
    border-radius: 8px; padding: 5px 12px; font: inherit; font-size: .82rem; cursor: pointer; }
  .winbtn.active { color: var(--ink); border-color: var(--accent); }
  .charts { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 14px; }
  .chart-label { color: var(--dim); font-size: .8rem; text-transform: uppercase;
    letter-spacing: .08em; margin-bottom: 8px; display: flex; gap: 12px; flex-wrap: wrap; }
  .ldot { display: inline-block; width: .55em; height: .55em; border-radius: 50%;
    margin-right: .35em; }
  canvas.histchart { width: 100%; height: 110px; display: block; }

  footer { margin-top: 24px; color: var(--dim); font-size: .84rem; line-height: 1.5; }
  footer code { color: var(--ink); }
`

export function getDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>WoT Broker Dashboard</title>
<style>${DASHBOARD_CSS}</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1><span class="dot" id="dot"></span><span class="host" id="host">broker</span></h1>
    <div class="sub">end-to-end encrypted &middot; updates every 2s <span id="status"></span></div>
  </header>

  <!-- Hero -->
  <div class="grid">
    <div class="card"><div class="label">Connections</div><div class="big" id="connections">&ndash;</div></div>
    <div class="card"><div class="label">Identities online</div><div class="big" id="dids">&ndash;</div></div>
    <div class="card"><div class="label">Shared spaces</div><div class="big" id="spaces">&ndash;</div></div>
    <div class="card"><div class="label">Messages in the log</div><div class="big" id="entries">&ndash;</div></div>
  </div>

  <!-- Performance -->
  <div class="row2">
    <div class="card">
      <div class="label">Activity &mdash; messages per 10s (last 5 min)</div>
      <canvas id="spark" width="800" height="120"></canvas>
    </div>
    <div class="card">
      <div class="label">Performance</div>
      <div class="vitals">
        <div class="vrow"><span>Rate</span><code id="rate">&ndash;</code></div>
        <div class="vrow"><span>Log size</span><code id="bytes">&ndash;</code></div>
        <div class="vrow"><span>Memory</span><code id="mem">&ndash;</code></div>
        <div class="vrow"><span>Uptime</span><code id="uptime">&ndash;</code></div>
      </div>
    </div>
  </div>

  <!-- Identities / Documents / Inbox -->
  <div class="cards3">
    <div class="card">
      <div class="label">Identities <span id="didsCount"></span></div>
      <div class="list" id="idlist"></div>
    </div>
    <div class="card">
      <div class="label">Documents <span id="docsAgg"></span></div>
      <div class="list" id="doclist"></div>
    </div>
    <div class="card">
      <div class="label">Inbox <span id="inboxAgg"></span></div>
      <div class="list" id="inboxlist"></div>
    </div>
  </div>

  <!-- History (metrics ring, /dashboard/metrics) -->
  <div class="histhead">
    <div class="label">History <span class="unit" id="histmeta"></span></div>
    <div class="winbtns" id="winbtns">
      <button class="winbtn" data-win="15m">15m</button>
      <button class="winbtn active" data-win="1h">1h</button>
      <button class="winbtn" data-win="6h">6h</button>
      <button class="winbtn" data-win="24h">24h</button>
    </div>
  </div>
  <div class="charts">
    <div class="card">
      <div class="chart-label"><span><span class="ldot" style="background:#4f8cff"></span>messages/s</span><span><span class="ldot" style="background:#ffb84f"></span>errors/s</span></div>
      <canvas id="ch-msg" class="histchart" width="800" height="110"></canvas>
    </div>
    <div class="card">
      <div class="chart-label"><span><span class="ldot" style="background:#4f8cff"></span>event-loop p99 ms</span><span><span class="ldot" style="background:#3ddc84"></span>sqlite write p95 ms</span></div>
      <canvas id="ch-lat" class="histchart" width="800" height="110"></canvas>
    </div>
    <div class="card">
      <div class="chart-label"><span><span class="ldot" style="background:#4f8cff"></span>cpu load (1m)</span><span><span class="ldot" style="background:#ffb84f"></span>temp &deg;C</span></div>
      <canvas id="ch-cpu" class="histchart" width="800" height="110"></canvas>
    </div>
    <div class="card">
      <div class="chart-label"><span><span class="ldot" style="background:#4f8cff"></span>relay rss MB</span><span><span class="ldot" style="background:#3ddc84"></span>host mem available MB</span></div>
      <canvas id="ch-mem" class="histchart" width="800" height="110"></canvas>
    </div>
    <div class="card">
      <div class="chart-label"><span><span class="ldot" style="background:#3ddc84"></span>net rx B/s</span><span><span class="ldot" style="background:#4f8cff"></span>net tx B/s</span></div>
      <canvas id="ch-net" class="histchart" width="800" height="110"></canvas>
    </div>
    <div class="card">
      <div class="chart-label"><span><span class="ldot" style="background:#4f8cff"></span>disk free MB</span></div>
      <canvas id="ch-disk" class="histchart" width="800" height="110"></canvas>
    </div>
  </div>

  <footer>
    All payloads are end-to-end encrypted &mdash; this broker only sees ciphertext and
    recipient DIDs. Identifiers are shortened unless full-detail mode is enabled.
    <span id="brokerline"></span>
  </footer>
</div>

<script>
const $ = id => document.getElementById(id)
// EVERY interpolated string is escaped before innerHTML — including shortened /
// hashed ids and (under the debug flag) full client-chosen docIds.
const esc = v => String(v).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
const fmtBytes = b => b < 1024 ? b + ' B' : b < 1048576 ? (b/1024).toFixed(1) + ' KB' : (b/1048576).toFixed(1) + ' MB'
const fmtUp = s => s < 60 ? Math.floor(s) + 's' : s < 3600 ? Math.floor(s/60) + 'm' : s < 86400 ? Math.floor(s/3600) + 'h ' + Math.floor(s%3600/60) + 'm' : Math.floor(s/86400) + 'd ' + Math.floor(s%86400/3600) + 'h'
// PRECEDENCE RULE (security-relevant): the server-shortened 'display' block is the
// DEFAULT source for the identities/documents/inbox cards. Full ids are rendered
// ONLY in full-detail mode, detected via the PRESENCE of the flag-gated fields
// (logStats.entriesByDoc / queueStats.byDid — emitted solely under
// RELAY_DEBUG_STATS). Detection must NOT key on devicesPerDid: it is ALWAYS public
// and contains full DIDs, so preferring it would show full DIDs on a public broker.
const isFullDetail = d => !!(((d.logStats || {}).entriesByDoc) || ((d.queueStats || {}).byDid))
// Max rows in the documents card (mirrors the server's DISPLAY_TOP_DOCS_LIMIT).
const TOP_DOCS_LIMIT = 12
// AbortSignal.timeout is missing in some older WebViews — tiny controller fallback.
const timeoutSignal = ms => {
  if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) return AbortSignal.timeout(ms)
  const c = new AbortController()
  setTimeout(() => c.abort(), ms)
  return c.signal
}

$('host').textContent = location.host || 'broker'
$('brokerline').innerHTML = '<code>' + esc(location.host || '') + '</code>'

// Pulse a hero number only when its rendered value actually changes (no bounce).
function setNum(el, val) {
  const s = String(val)
  if (el.textContent === s) return
  el.textContent = s
  el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash')
}

// Sparkline: one totalEntries-delta sample per 10s bucket, 5 min window (30 bars).
const hist = []
let lastEntries = null, lastSampleAt = 0, offlineSince = null

function draw() {
  const c = $('spark'), ctx = c.getContext('2d')
  ctx.clearRect(0, 0, c.width, c.height)
  const max = Math.max(1, ...hist)
  const w = c.width / 30
  ctx.fillStyle = '#4f8cff'
  hist.forEach((v, i) => {
    const h = Math.max(2, (v / max) * (c.height - 8))
    ctx.fillRect(i * w + 1, c.height - h, w - 2, h)
  })
}

function renderIdentities(d, full) {
  // DEFAULT: server-shortened display.dids. Full DIDs ONLY in full-detail mode
  // (flag-gated detection, see isFullDetail) — devicesPerDid itself is always
  // public and MUST NOT drive this decision.
  let rows
  if (full && d.devicesPerDid) {
    const online = new Set(d.connectedDids || [])
    rows = Object.entries(d.devicesPerDid)
      .map(([did, n]) => ({ id: did, dev: Number(n), on: online.has(did) }))
      .sort((a, b) => b.dev - a.dev)
  } else {
    rows = ((d.display && d.display.dids) || [])
      .map(x => ({ id: x.idShort, dev: Number(x.deviceCount), on: !!x.online }))
  }
  $('didsCount').textContent = rows.length ? '(' + rows.length + ')' : ''
  $('idlist').innerHTML = rows.length
    ? rows.map(r =>
        '<div class="lrow"><span class="id"><span class="pdot' + (r.on ? ' on' : '') + '"></span>' +
        '<code>' + esc(r.id) + '</code></span>' +
        '<span class="meta">' + r.dev + (r.dev === 1 ? ' device' : ' devices') + '</span></div>'
      ).join('')
    : '<div class="empty">no identities connected</div>'
}

function renderDocuments(d, full) {
  const ls = d.logStats || {}
  const spaces = Math.max(0, (ls.docCount || 0) - (ls.personalDocCount || 0))
  $('docsAgg').textContent = '(' + spaces + ' spaces · ' + (ls.personalDocCount || 0) + ' personal)'
  // DEFAULT: server-shortened display.topDocs; full docIds only in full-detail
  // mode (entriesByDoc is itself flag-gated, so the guard is belt-and-braces).
  let rows
  if (full && ls.entriesByDoc) {
    const dev = ls.devicesByDoc || {}
    rows = Object.entries(ls.entriesByDoc)
      .sort((a, b) => b[1] - a[1]).slice(0, TOP_DOCS_LIMIT)
      .map(([id, n]) => ({ id, entries: Number(n), devices: Number(dev[id] || 0) }))
  } else {
    rows = ((d.display && d.display.topDocs) || [])
      .map(x => ({ id: x.idShort, entries: Number(x.entries), devices: Number(x.devices) }))
  }
  const max = Math.max(1, ...rows.map(r => r.entries))
  $('doclist').innerHTML = rows.length
    ? rows.map(r =>
        '<div class="docrow"><code>' + esc(r.id) + '</code>' +
        '<span class="bar" style="width:' + ((r.entries / max) * 100) + '%"></span>' +
        '<span>' + r.entries + ' · ' + r.devices + ' dev</span></div>'
      ).join('')
    : '<div class="empty">no documents yet — connect and create a space</div>'
}

function renderInbox(d, full) {
  const q = d.queueStats || {}
  $('inboxAgg').textContent = '(' + (q.messages || 0) + ' retained · ' + (q.total || 0) + ' pending)'
  // DEFAULT: server-shortened display.inboxPendingByDid; full recipient DIDs only
  // in full-detail mode (byDid is itself flag-gated — belt-and-braces guard).
  let rows
  if (full && q.byDid) {
    rows = Object.entries(q.byDid).map(([did, n]) => ({ id: did, pending: Number(n) }))
      .sort((a, b) => b.pending - a.pending)
  } else {
    rows = ((d.display && d.display.inboxPendingByDid) || [])
      .map(x => ({ id: x.idShort, pending: Number(x.pending) }))
  }
  $('inboxlist').innerHTML = rows.length
    ? rows.map(r =>
        '<div class="lrow"><span class="id"><code>' + esc(r.id) + '</code></span>' +
        '<span class="meta">' + r.pending + ' pending</span></div>'
      ).join('')
    : '<div class="empty">no pending deliveries</div>'
}

function render(d) {
  const ls = d.logStats || {}
  setNum($('connections'), d.connectionCount || 0)
  setNum($('dids'), (d.connectedDids || []).length)
  setNum($('spaces'), Math.max(0, (ls.docCount || 0) - (ls.personalDocCount || 0)))
  setNum($('entries'), ls.totalEntries || 0)

  $('bytes').textContent = fmtBytes(ls.totalLogBytes || 0)
  $('mem').textContent = (typeof d.memoryMB === 'number' ? d.memoryMB.toFixed(1) : '?') + ' MB'
  $('uptime').textContent = fmtUp(d.uptimeSeconds || 0)

  // Rate: totalEntries delta per 10s bucket.
  const now = Date.now()
  if (lastEntries !== null && now - lastSampleAt >= 10000) {
    hist.push(Math.max(0, (ls.totalEntries || 0) - lastEntries))
    if (hist.length > 30) hist.shift()
    lastEntries = ls.totalEntries || 0
    lastSampleAt = now
    draw()
  } else if (lastEntries === null) {
    lastEntries = ls.totalEntries || 0
    lastSampleAt = now
  }
  $('rate').textContent = (hist.length ? hist[hist.length - 1] : 0) + ' msg/10s'

  // One flag-gated full-detail decision for all three cards (see isFullDetail).
  const full = isFullDetail(d)
  renderIdentities(d, full)
  renderDocuments(d, full)
  renderInbox(d, full)
}

// One gated fetch — a later SSE upgrade replaces only this source.
let inFlight = false
async function tick() {
  if (document.hidden || inFlight) return
  inFlight = true
  try {
    const r = await fetch('/dashboard/data', { cache: 'no-store', signal: timeoutSignal(4000) })
    if (!r.ok) throw new Error('HTTP ' + r.status)
    const d = await r.json()
    $('dot').classList.remove('off')
    $('status').textContent = ''
    offlineSince = null
    render(d)
  } catch {
    $('dot').classList.add('off')
    if (!offlineSince) offlineSince = Date.now()
    $('status').innerHTML = '<span class="offline">— relay unreachable (' + Math.round((Date.now() - offlineSince) / 1000) + 's)</span>'
  } finally {
    inFlight = false
  }
}

// Poll every 2s; a hidden tab produces zero load. Resume immediately on re-show.
setInterval(tick, 2000)
document.addEventListener('visibilitychange', () => { if (!document.hidden) tick() })
tick()

// ---- History charts — ENCAPSULATED tickMetrics() cycle -----------------------
// Separate from the live tick() (which stays untouched): 30s polling + immediate
// refresh on window switch, paused while the tab is hidden. Buckets are pure
// aggregates (no ids). Rates = counterSum / spanSeconds (spanSeconds grows under
// server-side downsampling, so rates stay honest across windows).
let metricsWindow = '1h'
let metricsInFlight = false
let metricsBuckets = []

const rate = (v, b) => v == null ? null : v / b.spanSeconds
const CHART_DEFS = [
  { id: 'ch-msg',  series: [{ color: '#4f8cff', f: b => rate(b.ingestOk, b) }, { color: '#ffb84f', f: b => rate(b.errorFramesSent, b) }] },
  { id: 'ch-lat',  series: [{ color: '#4f8cff', f: b => b.eventLoopLagP99Ms }, { color: '#3ddc84', f: b => b.sqliteWriteP95Ms }] },
  { id: 'ch-cpu',  series: [{ color: '#4f8cff', f: b => b.loadavg1 }, { color: '#ffb84f', f: b => b.cpuTempC }] },
  { id: 'ch-mem',  series: [{ color: '#4f8cff', f: b => b.rssMB }, { color: '#3ddc84', f: b => b.memAvailableMB }] },
  { id: 'ch-net',  series: [{ color: '#3ddc84', f: b => rate(b.netRxBytes, b) }, { color: '#4f8cff', f: b => rate(b.netTxBytes, b) }] },
  { id: 'ch-disk', series: [{ color: '#4f8cff', f: b => b.diskFreeMB }] },
]

const fmtShort = v => {
  const a = Math.abs(v)
  if (a >= 1e6) return (v / 1e6).toFixed(1) + 'M'
  if (a >= 1e3) return (v / 1e3).toFixed(1) + 'k'
  return a >= 10 ? String(Math.round(v)) : String(Math.round(v * 100) / 100)
}

// Simple polyline chart: shared y-scale across the chart's series, null values
// break the line (server gap buckets), min/max as plain canvas text labels.
function drawChart(def, buckets) {
  const c = $(def.id), ctx = c.getContext('2d')
  ctx.clearRect(0, 0, c.width, c.height)
  ctx.font = '12px system-ui, sans-serif'
  const seriesVals = def.series.map(s => buckets.map(s.f))
  let min = Infinity, max = -Infinity
  for (const vals of seriesVals) for (const v of vals) {
    if (v == null || !isFinite(v)) continue
    if (v < min) min = v
    if (v > max) max = v
  }
  if (!(min <= max)) {
    ctx.fillStyle = '#8a97ad'
    ctx.fillText('collecting…', 8, 18)
    return
  }
  if (min === max) { min -= 1; max += 1 } else {
    const pad = (max - min) * 0.08
    min -= pad; max += pad
  }
  const n = buckets.length
  const yOf = v => c.height - 4 - ((v - min) / (max - min)) * (c.height - 8)
  const xOf = i => n <= 1 ? c.width - 2 : (i / (n - 1)) * c.width
  for (let s = 0; s < def.series.length; s++) {
    ctx.strokeStyle = def.series[s].color
    ctx.lineWidth = 1.6
    ctx.beginPath()
    let pen = false
    for (let i = 0; i < n; i++) {
      const v = seriesVals[s][i]
      if (v == null || !isFinite(v)) { pen = false; continue }
      if (pen) ctx.lineTo(xOf(i), yOf(v))
      else { ctx.moveTo(xOf(i), yOf(v)); pen = true }
    }
    ctx.stroke()
  }
  ctx.fillStyle = '#8a97ad'
  ctx.fillText(fmtShort(max), 6, 14)
  ctx.fillText(fmtShort(min), 6, c.height - 5)
}

function renderMetrics() {
  for (const def of CHART_DEFS) drawChart(def, metricsBuckets)
  $('histmeta').textContent = metricsBuckets.length
    ? '(' + metricsBuckets.length + ' points · ' + metricsWindow + ')'
    : ''
}

async function tickMetrics() {
  if (document.hidden || metricsInFlight) return
  metricsInFlight = true
  try {
    const r = await fetch('/dashboard/metrics?window=' + encodeURIComponent(metricsWindow), {
      cache: 'no-store', signal: AbortSignal.timeout(8000),
    })
    if (!r.ok) throw new Error('HTTP ' + r.status)
    const d = await r.json()
    metricsBuckets = d.buckets || []
    renderMetrics()
  } catch {
    // Unreachability is already surfaced by the live tick(); charts keep last state.
  } finally {
    metricsInFlight = false
  }
}

$('winbtns').addEventListener('click', e => {
  const btn = e.target.closest('button[data-win]')
  if (!btn) return
  metricsWindow = btn.dataset.win
  for (const b of $('winbtns').querySelectorAll('.winbtn')) b.classList.toggle('active', b === btn)
  tickMetrics()
})

setInterval(tickMetrics, 30000)
document.addEventListener('visibilitychange', () => { if (!document.hidden) tickMetrics() })
tickMetrics()
</script>
</body>
</html>`
}

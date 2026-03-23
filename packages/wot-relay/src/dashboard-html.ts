const SHARED_CSS = `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; background: #0a0a0a; color: #e5e5e5; }
  .page { max-width: 960px; margin: 0 auto; padding: 24px 16px; }

  /* Header */
  .header { display: flex; align-items: center; gap: 12px; margin-bottom: 24px; }
  .header-badge { display: inline-flex; align-items: center; justify-content: center; padding: 4px 10px; border-radius: 6px; font-size: 11px; font-weight: 600; color: white; }
  .header h1 { font-size: 18px; font-weight: 600; }
  .header-sub { color: #525252; font-size: 11px; }

  /* Stats grid */
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 8px; margin-bottom: 20px; }
  .stat { background: #171717; border: 1px solid #262626; border-radius: 8px; padding: 12px; text-align: center; }
  .stat-val { font-size: 24px; font-weight: 700; font-variant-numeric: tabular-nums; line-height: 1.2; }
  .stat-label { font-size: 10px; color: #737373; margin-top: 2px; text-transform: uppercase; letter-spacing: 0.05em; }

  /* Colors */
  .green { color: #22c55e; }
  .amber { color: #f59e0b; }
  .red { color: #ef4444; }
  .purple { color: #a855f7; }
  .bg-green { background: #22c55e; }
  .bg-amber { background: #f59e0b; }
  .bg-purple { background: #a855f7; }

  /* Sections */
  .section { background: #171717; border: 1px solid #262626; border-radius: 8px; margin-bottom: 12px; overflow: hidden; }
  .section-head { padding: 10px 14px; font-size: 12px; font-weight: 600; border-bottom: 1px solid #262626; display: flex; align-items: center; gap: 8px; }
  .section-body { padding: 2px 0; }

  /* Rows */
  .row { display: flex; align-items: center; gap: 8px; padding: 6px 14px; border-bottom: 1px solid #1a1a1a; font-size: 12px; }
  .row:last-child { border-bottom: none; }
  .row-label { color: #737373; min-width: 80px; flex-shrink: 0; }
  .row-value { flex: 1; font-variant-numeric: tabular-nums; }
  .mono { font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace; font-size: 11px; }

  /* Direction arrows */
  .dir { display: inline-flex; width: 16px; justify-content: center; font-weight: 700; }
  .dir-out { color: #3b82f6; }
  .dir-in { color: #22c55e; }

  /* Table */
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th { text-align: left; color: #525252; font-weight: 500; padding: 6px 14px; font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; }
  td { padding: 6px 14px; border-top: 1px solid #1a1a1a; font-variant-numeric: tabular-nums; }
  td.mono { font-family: 'SF Mono', 'Fira Code', monospace; font-size: 11px; }

  /* Badge */
  .badge { display: inline-block; padding: 2px 6px; border-radius: 4px; font-size: 10px; font-weight: 500; }
  .badge-green { background: #22c55e20; color: #22c55e; }
  .badge-gray { background: #52525220; color: #737373; }
  .badge-red { background: #ef444420; color: #ef4444; }

  /* Footer */
  .footer { color: #525252; font-size: 11px; padding: 12px 14px; }
  .updated { color: #525252; font-size: 10px; text-align: right; padding: 8px 0; }

  /* Dot indicator */
  .dot { display: inline-block; width: 6px; height: 6px; border-radius: 50%; }
  .dot-green { background: #22c55e; }
  .dot-gray { background: #525252; }

  /* Empty state */
  .empty { color: #525252; font-size: 12px; padding: 16px 14px; }
`

export function getDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>WoT Relay Dashboard</title>
<style>${SHARED_CSS}</style>
</head>
<body>
<div class="page">
  <div class="header">
    <span class="header-badge bg-green">Relay</span>
    <div>
      <h1>Message Relay</h1>
      <div class="header-sub">wss://relay.utopia-lab.org</div>
    </div>
  </div>
  <div id="app">Laden...</div>
  <div class="updated" id="updated"></div>
</div>
<script>
async function refresh() {
  try {
    const r = await fetch('/dashboard/data')
    const d = await r.json()
    document.getElementById('app').innerHTML = render(d)
    document.getElementById('updated').textContent = 'Aktualisiert: ' + new Date().toLocaleTimeString('de-DE')
  } catch(e) {
    document.getElementById('updated').textContent = 'Fehler: ' + e.message
  }
}

function render(d) {
  const dids = d.connectedDids || []
  const queue = d.queueStats || {}
  const queueByDid = queue.byDid || {}
  const queueDids = Object.entries(queueByDid).sort((a, b) => b[1] - a[1])

  return \`
    <div class="stats">
      <div class="stat"><div class="stat-val green">\${d.connectionCount}</div><div class="stat-label">Verbindungen</div></div>
      <div class="stat"><div class="stat-val">\${dids.length}</div><div class="stat-label">DIDs online</div></div>
      <div class="stat"><div class="stat-val \${queue.total > 100 ? 'red' : queue.total > 10 ? 'amber' : ''}">\${queue.total ?? 0}</div><div class="stat-label">Queue</div></div>
      <div class="stat"><div class="stat-val">\${formatUptime(d.uptimeSeconds)}</div><div class="stat-label">Uptime</div></div>
      <div class="stat"><div class="stat-val">\${d.memoryMB?.toFixed(1) ?? '?'} MB</div><div class="stat-label">Speicher</div></div>
    </div>

    <div class="section">
      <div class="section-head">
        <span class="dot dot-green"></span>
        Verbundene DIDs (\${dids.length})
      </div>
      \${dids.length === 0 ? '<div class="empty">Keine Verbindungen</div>' : \`
        <table>
          <tr><th>DID</th><th>Devices</th><th>Queue</th></tr>
          \${dids.map(did => \`
            <tr>
              <td class="mono">\${did.slice(0, 20)}...\${did.slice(-6)}</td>
              <td>\${d.devicesPerDid?.[did] ?? 1}</td>
              <td>\${queueByDid[did] ? '<span class="badge badge-red">' + queueByDid[did] + '</span>' : '<span class="badge badge-gray">0</span>'}</td>
            </tr>
          \`).join('')}
        </table>
      \`}
    </div>

    \${queueDids.length > 0 ? \`
      <div class="section">
        <div class="section-head">Offline Queue (\${queue.total})</div>
        <table>
          <tr><th>DID</th><th>Nachrichten</th></tr>
          \${queueDids.map(([did, count]) => \`
            <tr>
              <td class="mono">\${did.slice(0, 20)}...\${did.slice(-6)}</td>
              <td><span class="badge badge-red">\${count}</span></td>
            </tr>
          \`).join('')}
        </table>
      </div>
    \` : ''}

    <div class="section">
      <div class="footer">
        Alle Nachrichten sind Ende-zu-Ende verschl\\u00fcsselt. Der Relay sieht nur verschl\\u00fcsselte Payloads und Empf\\u00e4nger-DIDs.
      </div>
    </div>
  \`
}

function formatUptime(s) {
  if (!s) return '?'
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d > 0) return d + 'd ' + h + 'h'
  return h > 0 ? h + 'h ' + m + 'm' : m + 'm'
}

refresh()
setInterval(refresh, 2000)
</script>
</body>
</html>`
}

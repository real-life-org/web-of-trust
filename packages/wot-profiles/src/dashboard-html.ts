const SHARED_CSS = `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; background: #0a0a0a; color: #e5e5e5; }
  .page { max-width: 960px; margin: 0 auto; padding: 24px 16px; }
  .header { display: flex; align-items: center; gap: 12px; margin-bottom: 24px; }
  .header-badge { display: inline-flex; align-items: center; justify-content: center; padding: 4px 10px; border-radius: 6px; font-size: 11px; font-weight: 600; color: white; }
  .header h1 { font-size: 18px; font-weight: 600; }
  .header-sub { color: #525252; font-size: 11px; }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 8px; margin-bottom: 20px; }
  .stat { background: #171717; border: 1px solid #262626; border-radius: 8px; padding: 12px; text-align: center; }
  .stat-val { font-size: 24px; font-weight: 700; font-variant-numeric: tabular-nums; line-height: 1.2; }
  .stat-label { font-size: 10px; color: #737373; margin-top: 2px; text-transform: uppercase; letter-spacing: 0.05em; }
  .amber { color: #f59e0b; }
  .bg-amber { background: #f59e0b; }
  .section { background: #171717; border: 1px solid #262626; border-radius: 8px; margin-bottom: 12px; overflow: hidden; }
  .section-head { padding: 10px 14px; font-size: 12px; font-weight: 600; border-bottom: 1px solid #262626; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th { text-align: left; color: #525252; font-weight: 500; padding: 6px 14px; font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; }
  td { padding: 6px 14px; border-top: 1px solid #1a1a1a; font-variant-numeric: tabular-nums; }
  td.mono { font-family: 'SF Mono', 'Fira Code', monospace; font-size: 11px; }
  .footer { color: #525252; font-size: 11px; padding: 12px 14px; }
  .updated { color: #525252; font-size: 10px; text-align: right; padding: 8px 0; }
  .empty { color: #525252; font-size: 12px; padding: 16px 14px; }
`

export function getProfilesDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>WoT Profiles Dashboard</title>
<style>${SHARED_CSS}</style>
</head>
<body>
<div class="page">
  <div class="header">
    <span class="header-badge bg-amber">Profiles</span>
    <div>
      <h1>Profile Discovery</h1>
      <div class="header-sub">https://profiles.utopia-lab.org</div>
    </div>
  </div>
  <div id="app">Laden...</div>
  <div class="updated" id="updated"></div>
</div>
<script>
function formatAge(iso) {
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 60000) return Math.floor(ms/1000) + 's'
  if (ms < 3600000) return Math.floor(ms/60000) + 'm'
  if (ms < 86400000) return Math.floor(ms/3600000) + 'h'
  return Math.floor(ms/86400000) + 'd'
}

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
  const recent = d.recentProfiles || []

  return \`
    <div class="stats">
      <div class="stat"><div class="stat-val amber">\${d.profileCount}</div><div class="stat-label">Profile</div></div>
      <div class="stat"><div class="stat-val">\${d.verificationCount}</div><div class="stat-label">Verifications</div></div>
      <div class="stat"><div class="stat-val">\${d.attestationCount}</div><div class="stat-label">Attestations</div></div>
      <div class="stat"><div class="stat-val">\${d.memoryMB?.toFixed(1) ?? '?'} MB</div><div class="stat-label">RAM</div></div>
    </div>

    <div class="section">
      <div class="section-head">Zuletzt aktualisierte Profile</div>
      \${recent.length === 0 ? '<div class="empty">Keine Profile</div>' : \`
        <table>
          <tr><th>DID</th><th>Aktualisiert</th></tr>
          \${recent.map(p => \`
            <tr>
              <td class="mono">\${p.did.slice(0, 20)}...\${p.did.slice(-6)}</td>
              <td style="color: #737373">\${formatAge(p.updated_at)}</td>
            </tr>
          \`).join('')}
        </table>
      \`}
    </div>

    <div class="section">
      <div class="footer">
        Profile sind JWS-signiert (Ed25519). Nur der Besitzer kann sein Profil aktualisieren. Profildaten sind \\u00f6ffentlich sichtbar.
      </div>
    </div>
  \`
}

refresh()
setInterval(refresh, 2000)
</script>
</body>
</html>`
}

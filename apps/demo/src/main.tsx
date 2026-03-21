import { Component, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

const errorStyle = 'padding:24px;font-family:monospace;font-size:13px;word-break:break-word;color:#e2e8f0;background:#0f172a;min-height:100vh'
const preStyle = 'background:#1e293b;color:#94a3b8;padding:12px;border-radius:8px;white-space:pre-wrap;overflow:auto;max-height:60vh'

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 24, fontFamily: 'monospace', fontSize: 13, whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: '#e2e8f0', background: '#0f172a', minHeight: '100vh' }}>
          <h1 style={{ color: '#f87171', fontSize: 18 }}>App Crash</h1>
          <p><strong>{this.state.error.message}</strong></p>
          <pre style={{ background: '#1e293b', color: '#94a3b8', padding: 12, borderRadius: 8, overflow: 'auto', maxHeight: '60vh' }}>
            {this.state.error.stack}
          </pre>
        </div>
      )
    }
    return this.props.children
  }
}

// Also catch unhandled errors outside React
window.addEventListener('error', (e) => {
  document.body.innerHTML = `<div style="${errorStyle}">
    <h1 style="color:#f87171">Unhandled Error</h1>
    <p><b>${e.message}</b></p>
    <pre style="${preStyle}">${e.error?.stack || e.filename + ':' + e.lineno}</pre>
  </div>`
})

window.addEventListener('unhandledrejection', (e) => {
  const err = e.reason
  document.body.innerHTML = `<div style="${errorStyle}">
    <h1 style="color:#f87171">Unhandled Promise Rejection</h1>
    <p><b>${err?.message || String(err)}</b></p>
    <pre style="${preStyle}">${err?.stack || ''}</pre>
  </div>`
})

createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
)

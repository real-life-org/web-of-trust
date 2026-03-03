import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Capacitor } from '@capacitor/core'
import './index.css'
import App from './App.tsx'

// On native platforms, request NFC permission early
if (Capacitor.isNativePlatform()) {
  import('./services/NfcService').then(({ requestNfcPermission }) => {
    requestNfcPermission().catch(console.warn)
  })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

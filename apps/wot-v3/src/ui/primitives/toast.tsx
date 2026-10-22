// Own toast (no Radix toast): one message at a time, aria-live="polite" (architecture §6.5).
// Usage: wrap the app in <ToastProvider>, call useToast().show(text).
import * as React from 'react'
import { cn } from './utils'

interface ToastApi {
  show(message: string): void
}

const ToastContext = React.createContext<ToastApi | null>(null)

function ToastProvider({ children, durationMs = 2600 }: { children: React.ReactNode; durationMs?: number }) {
  const [message, setMessage] = React.useState<string | null>(null)
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const api = React.useMemo<ToastApi>(
    () => ({
      show(next) {
        if (timer.current) clearTimeout(timer.current)
        setMessage(next)
        timer.current = setTimeout(() => setMessage(null), durationMs)
      },
    }),
    [durationMs],
  )
  React.useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current)
  }, [])
  return (
    <ToastContext.Provider value={api}>
      {children}
      <div aria-live="polite" role="status" className="pointer-events-none fixed inset-x-0 top-[calc(env(safe-area-inset-top)+12px)] z-[60] flex justify-center px-4">
        {message !== null && (
          <div
            className={cn(
              'pointer-events-auto max-w-sm rounded-lg border border-[color-mix(in_oklab,var(--success)_40%,transparent)] bg-card px-4 py-2.5 text-sm font-medium text-success-strong shadow-lg animate-toast-in',
            )}
          >
            {message}
          </div>
        )}
      </div>
    </ToastContext.Provider>
  )
}

function useToast(): ToastApi {
  const ctx = React.useContext(ToastContext)
  if (!ctx) throw new Error('useToast outside ToastProvider')
  return ctx
}

export { ToastProvider, useToast }

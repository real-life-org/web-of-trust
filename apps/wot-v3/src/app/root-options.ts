// React root options of the entry (main.tsx): every error React reports goes through the redacting
// log of lib/error-filter.ts (architecture §2.6, §5), never React's default raw print.
import type { RootOptions } from 'react-dom/client'
import { logError } from '../lib/error-filter'

export const ROOT_OPTIONS: RootOptions = {
  // ErrorBoundary logs what it catches, redacted; React's default would print the raw error
  onCaughtError: () => undefined,
  onUncaughtError: (error) => logError('uncaught render', error),
  onRecoverableError: (error) => logError('recoverable render', error),
}

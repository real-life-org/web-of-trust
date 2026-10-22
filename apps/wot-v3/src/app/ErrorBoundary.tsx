import { Component, type ReactNode } from 'react'
import { logError } from '../lib/error-filter'
import { ErrorScreen } from '../screens/system/ErrorScreen'

/** Crash path (architecture §2.6 kind 'bug'): the screen shows no error text, the log only the
 *  redacted one (lib/error-filter.ts). The React root does not log caught errors itself (main.tsx). */
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  override componentDidCatch(error: unknown): void {
    logError('render', error)
  }

  override render() {
    return this.state.failed ? <ErrorScreen /> : this.props.children
  }
}

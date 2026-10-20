import { Component, type ReactNode } from 'react'
import { ErrorScreen } from '../screens/system/ErrorScreen'

export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  override render() {
    return this.state.failed ? <ErrorScreen /> : this.props.children
  }
}

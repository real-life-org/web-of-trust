import '@testing-library/jest-dom/vitest'
import { afterEach } from 'vitest'

// Vitest runs without globals, so Testing Library cannot register its automatic cleanup.
afterEach(async () => {
  if (typeof document !== 'undefined') {
    const { cleanup } = await import('@testing-library/react')
    cleanup()
  }
})

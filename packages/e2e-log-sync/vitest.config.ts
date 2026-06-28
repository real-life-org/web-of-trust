import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // `node` environment (NOT happy-dom): the WebSocketMessagingAdapter connects via
    // globalThis.WebSocket (Node 22 built-in) to the REAL `ws`-backed RelayServer.
    // happy-dom would shadow globalThis.WebSocket with a non-functional stub.
    environment: 'node',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    // The real relay handshake + sync-request/sync-response round-trips are async
    // over a real socket; give catch-up convergence a comfortable budget.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
})

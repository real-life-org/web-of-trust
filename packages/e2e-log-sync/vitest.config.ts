import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // `node` environment (NOT happy-dom): the WebSocketMessagingAdapter connects via
    // globalThis.WebSocket (Node 22 built-in) to the REAL `ws`-backed RelayServer.
    // happy-dom would shadow globalThis.WebSocket with a non-functional stub.
    environment: 'node',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    // The long-running Festival-Scale-Stress runner (stress/) is NOT a vitest suite —
    // it is a standalone tsx script with 20-30-min runs. Restrict discovery to tests/
    // and exclude stress/ so vitest never picks it up (CI runs `vitest run` only).
    include: ['tests/**/*.test.ts'],
    exclude: ['stress/**', 'node_modules/**', 'dist/**'],
    // The real relay handshake + sync-request/sync-response round-trips are async
    // over a real socket; give catch-up convergence a comfortable budget.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
})

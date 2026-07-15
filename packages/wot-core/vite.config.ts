import { defineConfig } from 'vite'
import dts from 'vite-plugin-dts'
import { resolve } from 'path'

const entry = {
  index: resolve(__dirname, 'src/index.ts'),
  'protocol/index': resolve(__dirname, 'src/protocol/index.ts'),
  'adapters/protocol-crypto/index': resolve(__dirname, 'src/adapters/protocol-crypto/index.ts'),
  'crypto/index': resolve(__dirname, 'src/crypto/index.ts'),
  'application/index': resolve(__dirname, 'src/application/index.ts'),
  'ports/index': resolve(__dirname, 'src/ports/index.ts'),
  'adapters/index': resolve(__dirname, 'src/adapters/index.ts'),
  'adapters/discovery/http': resolve(__dirname, 'src/adapters/discovery/http.ts'),
  'adapters/messaging/websocket': resolve(__dirname, 'src/adapters/messaging/websocket.ts'),
  'adapters/storage/indexeddb': resolve(__dirname, 'src/adapters/storage/indexeddb.ts'),
  'adapters/storage/localstorage': resolve(__dirname, 'src/adapters/storage/localstorage.ts'),
  'storage/index': resolve(__dirname, 'src/storage/index.ts'),
  'types/index': resolve(__dirname, 'src/types/index.ts'),
}

export default defineConfig({
  plugins: [
    dts({
      include: ['src/**/*'],
      outDir: 'dist',
    }),
  ],
  build: {
    lib: {
      entry,
      formats: ['es'],
      fileName: (_format, entryName) => `${entryName}.js`,
    },
    rollupOptions: {
      external: ['react', 'idb'],
    },
  },
  test: {
    environment: 'happy-dom', // Browser-like environment for IndexedDB
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    // Die Suite enthält Integrations-Tests mit echter Crypto in Volumen
    // (z.B. VE-B1 HEADLINE: 250 Einträge × sign/encrypt/verify, ~2-5s Baseline).
    // Das vitest-Default-Timeout (5s) ist für Unit-Tests kalibriert und kippte
    // unter CI-Last regelmäßig ("Test timed out in 5000ms"-Flake-Familie).
    // 20s = konsistent mit packages/e2e-log-sync.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
})

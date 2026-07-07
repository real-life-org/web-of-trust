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
  },
})

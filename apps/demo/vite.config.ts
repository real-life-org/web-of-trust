import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import wasm from 'vite-plugin-wasm'
import topLevelAwait from 'vite-plugin-top-level-await'
import path from 'path'

const coreSrc = path.resolve(__dirname, '../../packages/wot-core/src')
const coreAlias = (subpath: string) => path.resolve(coreSrc, subpath, 'index.ts')

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, __dirname, '')
  return {
  plugins: [react(), tailwindcss(), wasm(), topLevelAwait()],
  base: env.VITE_BASE_PATH || '/',
  resolve: {
    alias: [
      { find: /^@web_of_trust\/core$/, replacement: path.resolve(coreSrc, 'index.ts') },
      { find: /^@web_of_trust\/core\/protocol$/, replacement: coreAlias('protocol') },
      { find: /^@web_of_trust\/core\/protocol-adapters$/, replacement: coreAlias('protocol-adapters') },
      { find: /^@web_of_trust\/core\/crypto$/, replacement: coreAlias('crypto') },
      { find: /^@web_of_trust\/core\/application$/, replacement: coreAlias('application') },
      { find: /^@web_of_trust\/core\/ports$/, replacement: coreAlias('ports') },
      { find: /^@web_of_trust\/core\/adapters$/, replacement: coreAlias('adapters') },
      { find: /^@web_of_trust\/core\/services$/, replacement: coreAlias('services') },
      { find: /^@web_of_trust\/core\/storage$/, replacement: coreAlias('storage') },
      { find: /^@web_of_trust\/core\/types$/, replacement: coreAlias('types') },
      // automerge-repo imports @automerge/automerge/slim (no WASM bundled).
      // Alias it to the full version which auto-initializes WASM.
      { find: '@automerge/automerge/slim', replacement: '@automerge/automerge' },
    ],
  },
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  optimizeDeps: {},
  test: {
    environment: 'happy-dom',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    exclude: ['e2e/**', 'node_modules/**'],
  },
  }
})

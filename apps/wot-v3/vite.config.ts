/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/** The five build targets of architecture §8.2. A missing or unknown target aborts the build. */
const TARGETS = ['fdroid', 'play', 'appstore', 'web', 'harness'] as const
type Target = (typeof TARGETS)[number]

const root = __dirname

function resolveTarget(): Target | null {
  // Vitest loads this config too; tests compose their own ports and need no target.
  if (process.env.VITEST) return null
  const raw = process.env.VITE_TARGET
  if (!raw || !(TARGETS as readonly string[]).includes(raw)) {
    throw new Error(
      `VITE_TARGET must be one of ${TARGETS.join(', ')} (got ${raw === undefined ? 'nothing' : JSON.stringify(raw)}). ` +
        'There is no default target (architecture §8.2).',
    )
  }
  return raw as Target
}

/**
 * Writes the resolved module graph of everything that ends up in an output chunk
 * (static and dynamic) to build-meta/module-graph.json, outside dist/ so it is never shipped.
 * scripts/check-build.mjs checks it (architecture §8.2, step 1).
 */
function moduleGraph(target: Target | null): Plugin {
  return {
    name: 'wot-module-graph',
    apply: 'build',
    generateBundle(_options, bundle) {
      const modules = new Set<string>()
      for (const output of Object.values(bundle)) {
        if (output.type !== 'chunk') continue
        for (const id of output.moduleIds) {
          const clean = id.replace(/\0/g, '').split('?')[0] ?? id
          modules.add(path.isAbsolute(clean) ? path.relative(root, clean) : clean)
        }
      }
      const dir = path.join(root, 'build-meta')
      mkdirSync(dir, { recursive: true })
      writeFileSync(
        path.join(dir, 'module-graph.json'),
        JSON.stringify({ target, modules: [...modules].sort() }, null, 2) + '\n',
      )
    },
  }
}

export default defineConfig(() => {
  const target = resolveTarget()
  return {
    plugins: [react(), tailwindcss(), moduleGraph(target)],
    base: process.env.VITE_BASE_PATH || '/',
    resolve: {
      alias: { '@': path.resolve(root, 'src') },
    },
    build: {
      sourcemap: false,
    },
    server: { port: 5273, strictPort: true },
    preview: { port: 5273, strictPort: true },
    test: {
      environment: 'happy-dom',
      setupFiles: ['./tests/setup.ts'],
      include: ['tests/**/*.test.{ts,tsx}'],
      exclude: ['e2e/**', 'node_modules/**', 'tests/boundaries/fixtures/**', 'tests/build-fixtures/**'],
      testTimeout: 20_000,
      hookTimeout: 20_000,
    },
  }
})

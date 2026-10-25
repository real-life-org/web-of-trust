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

/** Over-the-air updates may only ship in the F-Droid build, and not with the legacy kill switch
 *  VITE_DISABLE_LIVE_UPDATE=true (architecture §5 table, apps/demo #238). scripts/check-build.mjs rejects
 *  live-update code in every other build. */
function liveUpdateAllowed(target: Target | null): boolean {
  return target === 'fdroid' && process.env.VITE_DISABLE_LIVE_UPDATE !== 'true'
}

/**
 * Writes the resolved module graph of everything that ends up in an output chunk
 * (static and dynamic) to build-meta/module-graph.json, outside dist/ so it is never shipped.
 * scripts/check-build.mjs checks it (architecture §8.2, step 1).
 */
function moduleGraph(target: Target | null): Plugin {
  let mediator: string | null = null
  return {
    name: 'wot-module-graph',
    apply: 'build',
    // the mediator as the bundle sees it (import.meta.env): the shell before .env files, as Vite loads them
    configResolved(config) {
      mediator = (config.env.VITE_MEDIATOR_DID as string | undefined) || null
    },
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
        JSON.stringify({ target, liveUpdate: liveUpdateAllowed(target), mediator, modules: [...modules].sort() }, null, 2) + '\n',
      )
    },
  }
}

/** the seed files of the VTI mediator matrix (vitest project of their own) */
const MEDIATOR_MATRIX = 'tests/crash/transport-mediator-*.test.ts'

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
      // The scenario player page (architecture §7.3) exists only in the harness build.
      ...(target === 'harness'
        ? { rollupOptions: { input: { main: path.resolve(root, 'index.html'), harness: path.resolve(root, 'harness.html') } } }
        : {}),
    },
    server: { port: 5273, strictPort: true },
    preview: { port: 5273, strictPort: true },
    test: {
      environment: 'happy-dom',
      setupFiles: ['./tests/setup.ts'],
      testTimeout: 20_000,
      hookTimeout: 20_000,
      // `pnpm test:gc`: the projects' workers get --expose-gc (a CLI --execArgv does not reach them)
      execArgv: process.env.WOT_EXPOSE_GC === '1' ? ['--expose-gc'] : [],
      // The VTI mediator matrix (tests/crash/transport-mediator-*) runs real TSP and DIDComm crypto, a
      // seed per file: a project of its own, run after the rest of the suite and two files at a time,
      // so the load of the suite does not decide whether a seed stays within its bound.
      projects: [
        {
          extends: true as const,
          test: {
            name: 'unit',
            sequence: { groupOrder: 0 },
            include: ['tests/**/*.test.{ts,tsx}'],
            exclude: ['e2e/**', 'node_modules/**', 'tests/boundaries/fixtures/**', 'tests/build-fixtures/**', MEDIATOR_MATRIX],
          },
        },
        {
          extends: true as const,
          // after the rest of the suite (its own group), two seed files at a time
          test: { name: 'mediator-matrix', include: [MEDIATOR_MATRIX], maxWorkers: 2, sequence: { groupOrder: 1 } },
        },
      ],
    },
  }
})

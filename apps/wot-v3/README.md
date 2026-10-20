# Web of Trust v3

The store app on the Real Life Trust Protocol (`@real-life/trust-protocol`, pinned 0.5.0). Layers,
app port, simulation, the real adapter (encounter so far), identity and verify screens, boundary
checks. It is not shipped.
Until the cutover it lives next to `apps/demo`, so merges here trigger no web deploy, no OTA
update and no app release.

## Run

```bash
pnpm install                       # from the repo root
pnpm --filter wot-v3 dev           # harness target on http://localhost:5273
```

URL parameters of the harness: `scenario` (`iiw`, `iiw-future`, `empty`, the identity scenarios
`fresh-install`, `gen2-upgrade`, `locked`, `bio-invalidated`, `recovery`, and `encounter`: two phones
side by side on the real adapter and the real library over an in-memory carrier, `harness/pair.tsx`), `lang` (`en`, `de`),
`theme` (`light`, `dark`, `system`), `open` (a conversation key such as `c:priya`), `catalog` (an
identity or verify screen with a set state, ids in `harness/catalog.ts` and `harness/catalog-verify.ts`). The identity scenarios run the
identity runtime on a fake device; their passphrase is the public test value `harness passphrase`,
their words the public test phrase `abandon … about`.

## Layers

| Folder | Role | May import |
|---|---|---|
| `src/port/` | app port: read models, commands, events, errors, store helpers | only `src/port/` |
| `src/adapters/rltp/` | the real adapter; the only place that imports `@real-life/trust-protocol` (pinned 0.5.0): holder store and app-db in IndexedDB sealed under the DEK, write gate, serial sync (ingest, fence, projection), command service with the intent journal, transport (in-memory carrier for loopback; unconfigured until TSP) | port, `platform/ports.ts`, the library |
| `src/adapters/identity/` | identity runtime under the port, shared by both adapters: boot matrix, setup, restore, unlock, protection, delete, Gen-2 reset; words → root IKM | port, `platform/ports.ts`, `@scure/bip39` |
| `src/adapters/sim/` | simulation: in-memory world in port terms, simulated holder host | port, `platform/ports.ts`, `adapters/identity` |
| `src/platform/` | `ports.ts` (interfaces), `seed-vault/` (vault format §5.2, IndexedDB and memory backends), `capacitor/`, `web/`, `fake/` | `ports.ts`; Capacitor only in `capacitor/` |
| `src/flows/` | pure state machines with their transition tables: onboarding, recovery, unlock, protection, delete, Gen-2 reset, boot route, verify | port and `platform/ports.ts`, type-only |
| `src/hooks/` | React bridge over port stores (`useSyncExternalStore`); `flow-runner.ts` executes flow effects against port and platform | port, flows, `app/nav`, i18n |
| `src/ui/primitives/` | Radix + cva primitives on the WoT tokens, labels as props | Radix, cva, clsx, tailwind-merge |
| `src/ui/components/` | presentational components | primitives, i18n, port types |
| `src/screens/` | thin composition of hooks and components | hooks, ui, i18n, port types |
| `src/app/` | composition root, shell, navigation machine | everything except the library |
| `harness/` | scenarios, the screen catalogs, loopback devices (`loopback.ts`: real adapter on fake-indexeddb and a fake device) and the harness boot (build target `harness` only) | everything except the library |

The rules are enforced by `.dependency-cruiser.cjs` (CI gate) and `eslint.config.js` (editor
feedback). `tests/boundaries/fixtures/` holds one file per forbidden pattern; each must be rejected.

## Checks

| Script | What |
|---|---|
| `pnpm lint` | ESLint incl. import bans and no literal strings in screens and components |
| `pnpm typecheck` | app, tests, configs |
| `pnpm check:boundaries` | dependency-cruiser on `src` and `harness` |
| `pnpm check:boundaries:negative` | every negative fixture must be reported |
| `pnpm test` | Vitest: port contract on the simulation, port rules and the encounter on the real adapter (loopback over fake-indexeddb, `tests/rltp/`), flow transitions incl. verify, hooks, nav, Secret, port purity, i18n, build check |
| `pnpm build:web` | web build plus store-build check (`scripts/check-build.mjs`): no simulation in the module graph, no source maps, no scenario data |
| `pnpm e2e` | Playwright against the built harness: scaffold screens, every identity and verify screen, light and dark, and the two-phones encounter on the real library (not in CI; `WOT_CHROME_PATH` for a local Chromium, `WOT_E2E_DIAG=<file>` logs failed requests). No retries. On the development host of 18.10. the sandboxed Chromium aborts requests under parallel load with `net::ERR_INSUFFICIENT_RESOURCES` or `net::ERR_NETWORK_CHANGED`, reproduced with a static page and no app code; run there with `--workers=1` |

## Build targets

`VITE_TARGET` is required: `fdroid`, `play`, `appstore`, `web`, `harness`. A missing or unknown
target aborts the build. Store targets run the real adapter; documents wait before the trias until
the TSP transport exists. The web and native scanners come with the platform step; until then
"Scan code" leads to code entry. Native targets also need the platform step.

## Not here yet

- `android/`, `ios/`, `capacitor.config.ts`, `fastlane/`, `fdroid/`: they move from `apps/demo` in
  the cutover PR, when v3 takes over the `apps/demo` path (architecture §8.3).
- The rest of the real adapter (`src/adapters/rltp/TODO.md`): messages, reporting, blocking, trust,
  groups, the TSP transport; the scenario player (`harness.html`).
- Taken over from `apps/demo` with the platform step: error filter, scanner, live update. Biometrics
  (plugin interface with an alias per namespace; native code at cutover), clipboard, the seed vault
  (out of wot-core) and the Gen-2 names are here.

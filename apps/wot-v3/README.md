# Web of Trust v3

The store app on the Real Life Trust Protocol (`@real-life/trust-protocol`). This folder is the
scaffold: layers, app port, simulation, two screens, boundary checks. It is not shipped.
Until the cutover it lives next to `apps/demo`, so merges here trigger no web deploy, no OTA
update and no app release.

## Run

```bash
pnpm install                       # from the repo root
pnpm --filter wot-v3 dev           # harness target on http://localhost:5273
```

URL parameters of the harness: `scenario` (`iiw`, `iiw-future`, `empty`, and the identity scenarios
`fresh-install`, `gen2-upgrade`, `locked`, `bio-invalidated`, `recovery`), `lang` (`en`, `de`),
`theme` (`light`, `dark`, `system`), `open` (a conversation key such as `c:priya`), `catalog` (an
identity screen with a set state, ids in `harness/catalog.ts`). The identity scenarios run the
identity runtime on a fake device; their passphrase is the public test value `harness passphrase`,
their words the public test phrase `abandon … about`.

## Layers

| Folder | Role | May import |
|---|---|---|
| `src/port/` | app port: read models, commands, events, errors, store helpers | only `src/port/` |
| `src/adapters/rltp/` | the real adapter; the only place that imports `@real-life/trust-protocol` (pinned 0.4.0) | port, `platform/ports.ts`, the library |
| `src/adapters/identity/` | identity runtime under the port, shared by both adapters: boot matrix, setup, restore, unlock, protection, delete, Gen-2 reset; words → root IKM | port, `platform/ports.ts`, `@scure/bip39` |
| `src/adapters/sim/` | simulation: in-memory world in port terms, simulated holder host | port, `platform/ports.ts`, `adapters/identity` |
| `src/platform/` | `ports.ts` (interfaces), `seed-vault/` (vault format §5.2, IndexedDB and memory backends), `capacitor/`, `web/`, `fake/` | `ports.ts`; Capacitor only in `capacitor/` |
| `src/flows/` | pure state machines with their transition tables: onboarding, recovery, unlock, protection, delete, Gen-2 reset, boot route | port and `platform/ports.ts`, type-only |
| `src/hooks/` | React bridge over port stores (`useSyncExternalStore`); `flow-runner.ts` executes flow effects against port and platform | port, flows, `app/nav`, i18n |
| `src/ui/primitives/` | Radix + cva primitives on the WoT tokens, labels as props | Radix, cva, clsx, tailwind-merge |
| `src/ui/components/` | presentational components | primitives, i18n, port types |
| `src/screens/` | thin composition of hooks and components | hooks, ui, i18n, port types |
| `src/app/` | composition root, shell, navigation machine | everything except the library |
| `harness/` | scenarios and the harness boot (build target `harness` only) | everything except the library |

The rules are enforced by `.dependency-cruiser.cjs` (CI gate) and `eslint.config.js` (editor
feedback). `tests/boundaries/fixtures/` holds one file per forbidden pattern; each must be rejected.

## Checks

| Script | What |
|---|---|
| `pnpm lint` | ESLint incl. import bans and no literal strings in screens and components |
| `pnpm typecheck` | app, tests, configs |
| `pnpm check:boundaries` | dependency-cruiser on `src` and `harness` |
| `pnpm check:boundaries:negative` | every negative fixture must be reported |
| `pnpm test` | Vitest: port contract on the simulation, hooks, nav, Secret, port purity, i18n, build check |
| `pnpm build:web` | web build plus store-build check (`scripts/check-build.mjs`): no simulation in the module graph, no source maps, no scenario data |
| `pnpm e2e` | Playwright screenshots of the two screens, light and dark (not in CI; set `WOT_CHROME_PATH` to use a local Chromium) |

## Build targets

`VITE_TARGET` is required: `fdroid`, `play`, `appstore`, `web`, `harness`. A missing or unknown
target aborts the build. In the scaffold, the real adapter throws `NotImplementedError`, so store
targets render a "not available yet" screen; native targets also need the platform step.

## Not here yet

- `android/`, `ios/`, `capacitor.config.ts`, `fastlane/`, `fdroid/`: they move from `apps/demo` in
  the cutover PR, when v3 takes over the `apps/demo` path (architecture §8.3).
- The real adapter (`src/adapters/rltp/TODO.md` lists what the library still lacks; the identity
  runtime needs its holder host), the command service with the intent journal, the scenario player
  (`harness.html`).
- Taken over from `apps/demo` with the platform step: error filter, scanner, live update. Biometrics
  (plugin interface with an alias per namespace; native code at cutover), clipboard, the seed vault
  (out of wot-core) and the Gen-2 names are here.

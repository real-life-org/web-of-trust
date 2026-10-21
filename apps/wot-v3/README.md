# Web of Trust v3

The store app on the Real Life Trust Protocol (`@real-life/trust-protocol`, pinned 0.6.0). Layers,
app port, simulation, the real adapter (encounter, 1:1 messages, report and block so far), identity,
verify, conversation and report screens, boundary checks. It is not shipped.
Until the cutover it lives next to `apps/demo`, so merges here trigger no web deploy, no OTA
update and no app release.

## Run

```bash
pnpm install                       # from the repo root
pnpm --filter wot-v3 dev           # harness target on http://localhost:5273
```

URL parameters of the harness: `scenario` (`iiw`, `iiw-future`, `empty`, the identity scenarios
`fresh-install`, `gen2-upgrade`, `locked`, `bio-invalidated`, `recovery`, `message-states`, and
`encounter` / `conversation` / `blocked`: two phones side by side on the real adapter and the real
library over an in-memory carrier, not met yet, met with a few messages, or with one blocking the
other, `harness/pair.tsx`), `lang` (`en`, `de`),
`theme` (`light`, `dark`, `system`), `open` (a conversation key such as `c:priya`), `catalog` (an
identity, verify or report screen with a set state, ids in `harness/catalog.ts`,
`harness/catalog-verify.ts` and `harness/catalog-report.ts`). The identity scenarios run the
identity runtime on a fake device; their passphrase is the public test value `harness passphrase`,
their words the public test phrase `abandon … about`.

### Scenario player

`http://localhost:5273/harness.html` (architecture §7.3; `?scenario=<id>` preselects one, default
`iiw-duo`). Harness target only; `scripts/check-build.mjs` rejects a store build that ships it.

- **Phones**: one to three side by side, each an iframe with its own app instance, fake device,
  identity runtime and simulated holder (`harness.html?phone=<n>`). Scenarios with `phones`
  (`iiw-duo`: Jonas, Priya, Marcus) give each phone its own scenario; any other scenario runs as
  independent devices. Data scenarios run unlocked (`passphrase+biometric`), so every fault switch
  has a runtime to act on.
- **Shared sim transport** (`harness/player/transport.ts`): a timeline `send` step echoes on the
  sender and is delivered to the receiver's world; while the transport is gone, deliveries queue in
  order and arrive when it is back.
- **Timeline**: the scenario's `timeline` as a step list with play, pause, single step and reset;
  `at` is the virtual-time offset to the previous step (`+10s`, `+5m`, `+1h`, `+1d`).
- **Clock**: −1 h (device clock set back: connectivity `clock: behind` until time passes the
  high-water mark again), +1 min, +1 h, +1 day, jump to a local scenario time.
- **Faults**: transport gone (connectivity `carrier: unreachable`, queued count), vault write fails
  (every seed vault write transaction aborts), biometrics unavailable, host close fails (S5 throws).
- **View**: number of phones, language, theme (live, no reload), screen catalog on phone 1.
- **Inspector**: per phone identity status, open holders, connectivity, faults, contact count and the
  fake device's operation names; no words, passphrases or keys. Transport state and the player log.

The model (`harness/player/player.ts`, `phone.ts`, `transport.ts`, `timeline.ts`) has no React and is
tested in `tests/harness-player.test.ts`; the panels (`harness/player/ui/`) are pure components on
`src/ui/primitives`; `e2e/player.spec.ts` drives the page (`WOT_PLAYER_SHOTS=<dir>` writes screenshots).

## Layers

| Folder | Role | May import |
|---|---|---|
| `src/port/` | app port: read models, commands, events, errors, store helpers | only `src/port/` |
| `src/adapters/rltp/` | the real adapter; the only place that imports `@real-life/trust-protocol` (pinned 0.6.0): holder store and app-db in IndexedDB sealed under the DEK, write gate, serial sync (ingest, fence, projection), command service with the intent journal, transport (in-memory carrier for loopback; unconfigured until TSP) | port, `platform/ports.ts`, the library |
| `src/adapters/identity/` | identity runtime under the port, shared by both adapters: boot matrix, setup, restore, unlock, protection, delete, Gen-2 reset; words → root IKM | port, `platform/ports.ts`, `@scure/bip39` |
| `src/adapters/sim/` | simulation: in-memory world in port terms, simulated holder host | port, `platform/ports.ts`, `adapters/identity` |
| `src/platform/` | `ports.ts` (interfaces), `seed-vault/` (vault format §5.2, IndexedDB and memory backends), `capacitor/`, `web/`, `fake/` | `ports.ts`; Capacitor only in `capacitor/` |
| `src/flows/` | pure state machines with their transition tables: onboarding, recovery, unlock, protection, delete, Gen-2 reset, boot route, verify | port and `platform/ports.ts`, type-only |
| `src/hooks/` | React bridge over port stores (`useSyncExternalStore`); `flow-runner.ts` executes flow effects against port and platform | port, flows, `app/nav`, i18n |
| `src/ui/primitives/` | Radix + cva primitives on the WoT tokens, labels as props | Radix, cva, clsx, tailwind-merge |
| `src/ui/components/` | presentational components | primitives, i18n, port types |
| `src/screens/` | thin composition of hooks and components | hooks, ui, i18n, port types |
| `src/app/` | composition root, shell, navigation machine | everything except the library |
| `harness/` | scenarios, the screen catalogs, loopback devices (`loopback.ts`: real adapter on fake-indexeddb and a fake device), harness boot, scenario player (build target `harness` only) | everything except the library; nothing in `src/` imports it except the dynamic import of `harness/boot` in `app/compose.ts` |

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
| `pnpm e2e` | Playwright against the built harness: scaffold screens, every identity and verify screen light and dark, the two-phones encounter on the real library, the scenario player (not in CI; `WOT_CHROME_PATH` for a local Chromium, `WOT_E2E_DIAG=<file>` logs failed requests). No retries. On the development host of 18.10. the sandboxed Chromium aborts requests under parallel load with `net::ERR_INSUFFICIENT_RESOURCES` or `net::ERR_NETWORK_CHANGED`, reproduced with a static page and no app code; run there with `--workers=1` |

## Build targets

`VITE_TARGET` is required: `fdroid`, `play`, `appstore`, `web`, `harness`. A missing or unknown
target aborts the build. Store targets run the real adapter; documents wait before the trias until
the TSP transport exists. The web and native scanners come with the platform step; until then
"Scan code" leads to code entry. Native targets also need the platform step.

## Not here yet

- `android/`, `ios/`, `capacitor.config.ts`, `fastlane/`, `fdroid/`: they move from `apps/demo` in
  the cutover PR, when v3 takes over the `apps/demo` path (architecture §8.3).
- The rest of the real adapter (`src/adapters/rltp/TODO.md` lists what the library still lacks):
  messages, reporting, blocking, trust, groups, the TSP transport; the command service with the
  intent journal. The player still lacks counterpart scripts, checkpoints, the desktop frame and
  "scan" between two phones.
- Taken over from `apps/demo` with the platform step: error filter, scanner, live update. Biometrics
  (plugin interface with an alias per namespace; native code at cutover), clipboard, the seed vault
  (out of wot-core) and the Gen-2 names are here.

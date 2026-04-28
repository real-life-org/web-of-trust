# Reference Implementation Refactor

## Goal

Build the demo app into a clean reference implementation of the WoT protocol instead of adapting the new protocol code into the legacy app architecture.

The result should be usable in three layers:

- Protocol implementation for conformance and interoperability.
- Framework-free application workflows for real product behavior.
- React hooks that third-party developers can use later.

## Naming

The implementation should not expose the core protocol package as `spec` long-term.

Target naming:

```txt
packages/wot-core/src/protocol
```

Rationale:

- `wot-spec` remains the normative specification repository.
- `protocol` describes the deterministic implementation of those rules.
- The library API should feel like production code, not a test-vector harness.

The former protocol implementation package has been renamed to `src/protocol` on this branch.

## Architecture

Target package structure:

```txt
packages/wot-core/src/
  protocol/
    crypto/
    identity/
    trust/
    sync/
    devices/

  application/
    identity/
    verification/
    attestations/
    devices/
    spaces/

  ports/
    crypto.ts
    identity-store.ts
    key-store.ts
    verification-store.ts
    attestation-store.ts
    transport.ts
    clock.ts
    random.ts

  adapters/
    crypto/
    storage/
    transport/
```

React hooks may start inside the demo app while the API stabilizes:

```txt
apps/demo/src/hooks/wot/
```

Later extraction target:

```txt
packages/wot-react/src/
  WotProvider.tsx
  useIdentity.ts
  useVerification.ts
  useAttestations.ts
  useDeviceKeys.ts
  useSpaces.ts
```

## Dependency Rules

The dependency direction is strict:

```txt
protocol <- application <- react <- app
ports <- application
ports <- adapters
app composes application + adapters
```

Rules:

- `protocol` imports no application, storage, network, React, CRDT, or demo code.
- `application` imports `protocol` and `ports` only.
- `adapters` implement `ports`; they may use platform APIs and protocol helpers.
- React hooks use application workflows, not protocol primitives directly unless there is a clear reason.
- The demo app is the composition root: it wires adapters into application services/hooks.
- Do not add legacy bridges just to preserve old internal shapes.

## Spec Feedback Rule

If implementation work exposes a real protocol blocker, do not solve it with a local workaround in the reference implementation.

Instead:

- Return to `wot-spec`.
- Clarify or change the protocol semantics there.
- Add or update schemas and test vectors if needed.
- Re-run spec validation.
- Then update the TypeScript protocol implementation against the clarified contract.

This applies especially to:

- ambiguous payload semantics
- missing required fields
- time, expiry, or revocation rules
- Device Key edge cases
- sync/log conflict rules
- DID, KID, key agreement, and service resolution questions
- JSON Canonicalization, JWS, or encoding incompatibilities

Allowed implementation-local fixes:

- UI behavior
- browser, mobile, storage, or transport adapter details
- performance and caching details
- temporary debug helpers that do not enter `protocol` or `application`

## SOLID Guidance

Single Responsibility:

- Protocol modules implement deterministic protocol rules.
- Application modules implement workflows/use-cases.
- Ports describe external capabilities.
- Adapters touch the outside world.
- Hooks expose UI-friendly state and actions.

Open/Closed:

- New storage, crypto, or transport adapters should not require changing application use-cases.

Liskov Substitution:

- Port contracts must be narrow and explicit enough that in-memory, IndexedDB, and mobile adapters behave interchangeably.

Interface Segregation:

- Avoid broad `AppAdapter` or `RuntimeAdapter` interfaces.
- Prefer small ports such as `IdentityStore`, `AttestationStore`, `Transport`, `Clock`, and `Random`.

Dependency Inversion:

- Application workflows depend on ports, never concrete browser/mobile implementations.
- Concrete adapters are selected in the app composition root.

## TDD Strategy

Use TDD where it creates architectural pressure in the right direction.

Test pyramid:

```txt
1. protocol vector tests
2. application use-case tests with fake ports
3. adapter contract tests
4. React hook behavior tests
5. small E2E smoke suite
```

Protocol tests:

- Use vendored `wot-spec` vectors.
- Keep deterministic and fast.
- Cover DID/key derivation, JCS/JWS, attestations, device delegation, sync crypto, and capabilities.

Application tests:

- Write use-case tests before workflow implementation.
- Use in-memory stores, fixed clocks, and deterministic random sources.
- Test product behavior, not UI details.

Adapter contract tests:

- Define reusable contract test suites for each port.
- Run the same contract against in-memory and real adapters.

React hook tests:

- Test hook state transitions and error handling.
- Do not retest cryptography in hooks.

E2E tests:

- Keep only key user journeys: identity onboarding, recovery, verification, attestation, and later device delegation/spaces.

## Existing Test Migration

The current test suite contains product knowledge and should be migrated deliberately, not discarded.

Classify every existing test into one of these buckets:

- `protocol`: crypto, DID, JWS, VC, encryption, device delegation semantics.
- `application`: identity lifecycle, verification flow, attestation flow, delivery state, sync workflows.
- `adapter`: storage, outbox, graph cache, CRDT row mapping, transport behavior.
- `react`: hook state and UI-facing behavior.
- `e2e`: cross-screen user flows.
- `legacy`: tests that only pin obsolete internal implementation details.

Migration rule:

- Do not delete a legacy test until an equivalent protocol/application/adapter/react/e2e test covers the same behavior, or until we explicitly decide the behavior is no longer desired.

Examples:

- Onboarding/recovery tests become identity application and hook tests.
- Verification integration tests become application verification use-case tests plus a smaller UI smoke test.
- Attestation delivery tests become application state-machine tests plus transport/outbox contract tests.
- Row mapper tests become adapter contract tests or stay near the adapter.
- Existing multi-device/offline E2E tests remain regression references until new slices replace them.

## Vertical Slices

Avoid a big-bang rewrite. Refactor in vertical slices.

### 1. Protocol Rename

Status: implemented on the `demo-spec-reference` branch.

Acceptance criteria:

- Protocol implementation code lives in `src/protocol`.
- Protocol platform crypto code lives in `src/protocol-adapters`.
- Public exports use `protocol`, not `spec`.
- Existing protocol vector tests pass.

### 2. Identity

Status: implemented for the core application workflow and demo onboarding/recovery/unlock flow on the `demo-spec-reference` branch. The legacy `WotIdentity` surface still exists for legacy tests and callers, but the new demo identity flow no longer constructs it.

Acceptance criteria:

- Framework-free identity application workflow exists.
- Create identity, recover identity, unlock stored identity, and delete identity are covered by use-case tests.
- Demo onboarding and recovery use the new identity workflow.
- Old `WotIdentity` is no longer used by the new flow.

### 3. Verification

Status: implemented for the framework-free verification workflow and demo verification hook on the `demo-spec-reference` branch. The legacy `VerificationHelper` compatibility facade has been removed; callers and tests now use `VerificationWorkflow` directly.

Acceptance criteria:

- Challenge/response or replacement verification workflow is implemented in application layer.
- Self-verification rejection and mutual verification behavior are covered by tests.
- Demo verification UI uses the new workflow.

### 4. Attestations

Status: implemented for the framework-free attestation workflow and demo attestation service on the `demo-spec-reference` branch. New attestations keep the legacy app shape and additionally carry a protocol-compatible `vc+jwt` JWS.

Acceptance criteria:

- Attestations are represented as protocol-compatible VC-JWS artifacts.
- Create, verify, store, send, receive, and acknowledge behavior are tested.
- Demo attestation UI uses the new workflow.

### 5. Device Keys

Acceptance criteria:

- Device key creation and binding are exposed through application workflows.
- Delegated attestation signing is supported.
- Revocation or expiry behavior follows the current protocol decision.

### 6. Spaces And Sync

Status: first application workflow implemented on the `demo-spec-reference` branch. `SpacesWorkflow` now owns framework-free space creation, metadata updates, member invites/removals, leaving, and explicit sync requests. The demo `useSpaces` hook delegates those commands to the workflow while CRDT-specific document sync remains in the Yjs/Automerge adapters.

Acceptance criteria:

- Spaces use protocol log entries, encrypted payloads, and capabilities.
- Existing offline and multi-device behavior is preserved or consciously changed.
- E2E smoke tests cover create space, invite/join, sync, and offline restore.

Remaining work:

- Move more sync policy out of CRDT adapters only where it is product behavior rather than adapter mechanics.
- Decide whether current encrypted payload and capability helpers are the final protocol surface for shared spaces.
- Add focused application tests for group-key rotation and restore behavior before changing adapter internals.

## Non-Goals

- No attempt to force the new protocol implementation into legacy service shapes.
- No broad framework abstraction before at least one working vertical slice exists.
- No UI redesign as part of the architecture refactor unless a screen must change for the new workflow.
- No DIDComm mediator/JWE stack in core protocol unless the spec explicitly grows that requirement.

## Composition Root

The demo app should wire concrete adapters in one place.

Example target shape:

```ts
const runtime = createWotRuntime({
  crypto: new WebCryptoAdapter(),
  identityStore: new IndexedDbIdentityStore(),
  attestationStore: new IndexedDbAttestationStore(),
  verificationStore: new IndexedDbVerificationStore(),
  transport: new RelayTransport(relayUrl),
  clock: systemClock,
  random: webRandom,
})
```

React receives the runtime through a provider:

```tsx
<WotProvider runtime={runtime}>
  <App />
</WotProvider>
```

## First Step

Start with the protocol rename and test migration inventory before changing demo behavior.

Then implement the identity slice test-first.

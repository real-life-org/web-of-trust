# vNext TypeScript Target Architecture

## Purpose

This document keeps the long-horizon TypeScript implementation goal in repository context. It is not a protocol specification. `wot-spec` remains the normative source for protocol behavior, schemas, and vectors.

The TypeScript implementation should become a clean reference implementation of `wot-spec` vNext, not a second protocol design and not a compatibility layer around legacy app internals.

## Long-Horizon Goal

Bring `web-of-trust` toward `wot-spec` vNext conformance by replacing legacy implementation paths with small, reviewed, test-first TypeScript slices.

Each slice must leave the repository closer to this target:

- Protocol behavior is deterministic and traceable to `wot-spec`.
- Product workflows live in framework-free application modules.
- External storage, transport, crypto, and platform behavior enter through narrow ports and adapters.
- React/demo code composes application workflows and adapters; it does not define protocol semantics.
- Legacy paths are retired deliberately instead of preserved by default.

## Layer Boundaries

```text
wot-spec documents, schemas, vectors
  -> packages/wot-core/src/protocol
  -> packages/wot-core/src/application
  -> packages/wot-core/src/ports
  -> packages/wot-core/src/adapters
  -> apps/demo or future packages/wot-react
```

Rules:

- `protocol` imports no application, storage, network, React, CRDT, or demo code.
- `application` imports `protocol` and `ports`, not concrete adapters or React.
- `ports` define narrow capability contracts.
- `adapters` implement ports and may touch platform APIs, CRDTs, network, IndexedDB, mobile plugins, or HTTP/WebSocket clients.
- Demo/app code is the composition root.
- Vendored distributions such as `packages/wot-vault/wot-core-dist/` are generated delivery artifacts, not source of truth.

## Slice Size

Prefer small or medium PRs:

- One normative spec section, schema, vector section, or application workflow edge per PR.
- One primary layer transition per PR.
- Tests first, then implementation, then legacy cleanup or tracking update.
- Reviewable in one sitting.

Avoid PRs that mix protocol semantics, crypto decisions, storage migrations, app UI rewrites, and legacy deletion unless a human explicitly approves that larger scope.

## Test-First Rule

Every implementation slice that changes behavior must define the failing test or conformance evidence before changing production code. See `docs/automation/tdd-agent-flow.md`.

Accepted test layers:

- Protocol vector or schema behavior tests.
- Application use-case tests with fake ports.
- Adapter contract tests.
- React hook behavior tests.
- Minimal E2E smoke tests for cross-screen journeys.

## Legacy Replacement Rule

Do not build new architecture beside old architecture indefinitely. Every slice must state its legacy impact:

- `none`: no known legacy surface is touched.
- `contains`: legacy stays but no new dependency is added.
- `replaces`: new path covers behavior previously owned by legacy code.
- `removes`: legacy code or compatibility facade is deleted.
- `blocks`: human decision needed before retirement.

Track this in `docs/architecture/legacy-retirement.md`.

## Conformance Tracking Rule

Every slice that claims spec progress must update `docs/conformance/ts-implementation-map.md` in the same PR unless the PR is explicitly docs-only or infrastructure-only.

The map must name:

- Spec profile or document.
- Schema/vector section when available.
- TS implementation path.
- Test command or test file.
- Status and remaining gap.

## Human Gates

Stop for human decision before merge when a slice requires:

- Normative `wot-spec` changes.
- Crypto, signature, DID/JWS, key-management, authorization, or storage-confidentiality changes.
- Breaking public API behavior.
- Persistent data migration.
- External service/app activation.
- Compatibility wrapper retention that would preserve old architecture beyond one slice.
- Ambiguous or conflicting spec interpretation.

## Done Criteria

A vNext TS slice is done only when:

- Tests were written first or the PR explains why the slice is docs/infrastructure-only.
- The relevant checks pass.
- The conformance map is updated or explicitly unchanged.
- The legacy retirement map is updated or explicitly unchanged.
- Scope gate is clean.
- Reviewer findings are resolved or escalated to a human gate.
- The PR remains human-controlled; no auto-merge or release.

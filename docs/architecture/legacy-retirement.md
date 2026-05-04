# Legacy Retirement Map

## Purpose

This document tracks old implementation paths that must be contained, replaced, or removed as the vNext TypeScript reference implementation grows.

The goal is not to delete working behavior blindly. The goal is to prevent permanent double architecture.

## Status Legend

- `active`: still used and not yet scoped for replacement.
- `contained`: may remain temporarily, but new work must not deepen the dependency.
- `replacing`: a vNext path is being introduced for the same behavior.
- `ready-to-remove`: replacement coverage exists; removal can be scoped.
- `removed`: legacy path was deleted.
- `blocked`: needs human/spec decision.
- `inventory-required`: suspected legacy surface; confirm before changing.

## Retirement Rules

- Do not add new dependencies on a contained or superseded legacy surface.
- Write replacement tests before removing behavior.
- Do not keep compatibility facades unless a human approves the reason and expiry condition.
- Delete legacy code only when equivalent protocol/application/adapter/react/e2e coverage exists, or when a human decides the behavior is obsolete.
- Update this file in every PR that replaces, removes, or intentionally preserves a legacy path.

## Candidate Legacy Surfaces

| Surface | Current Status | Target Replacement | Required Evidence | Notes |
|---|---|---|---|---|
| `packages/wot-core/src/identity/WotIdentity.ts` | `contained` | Protocol identity helpers plus framework-free application identity workflow. | Identity protocol vectors and application identity workflow tests. | Existing callers may remain until each call site is migrated by slice. Do not add new product behavior here. |
| `packages/wot-core/src/crypto/jws.ts`, `packages/wot-core/src/crypto/encoding.ts`, `packages/wot-core/src/crypto/did.ts` | `inventory-required` | `packages/wot-core/src/protocol/crypto/` and protocol identity modules. | Protocol interop tests and import inventory. | Confirm which files are legacy facades versus still-needed public APIs before deletion. |
| `packages/wot-core/src/services/*` | `active` | `packages/wot-core/src/application/*` workflows plus narrow ports. | Application use-case tests with fake ports. | Migrate service responsibilities one workflow at a time. |
| `packages/wot-core/src/storage/*` CRDT/persistence managers | `active` | Storage adapters behind explicit ports, with protocol/application logic moved out. | Adapter contract tests and existing persistence regression tests. | CRDT mechanics may remain adapter-owned; product policy should move to application layer. |
| Demo hooks and services under `apps/demo/src/` | `active` | Composition root plus future `packages/wot-react` hooks. | Hook behavior tests or E2E smoke tests. | Do not move hooks prematurely; migrate when application workflows are stable. |
| `packages/wot-vault/wot-core-dist/` | generated artifact | Refresh from `packages/wot-core` build output. | Build output after `packages/wot-vault/docker-build.sh`. | Never hand-edit as source. Include only when core distribution changes require it. |

## Slice Checklist

For every implementation slice, answer:

- Which legacy surface is touched?
- Is the slice adding a new dependency on legacy code?
- Which test proves the replacement behavior?
- Can anything be deleted now?
- If not deleted, what blocks removal?

## Metrics

Useful progress metrics for automation and review:

- Count of `contained`, `replacing`, and `ready-to-remove` rows.
- Number of new imports from contained legacy surfaces.
- Number of PRs that update conformance without updating this map.
- Number of compatibility facades without an expiry condition.

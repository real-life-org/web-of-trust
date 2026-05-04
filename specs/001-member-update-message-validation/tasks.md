---
description: "Task list for member-update message validation"
---

# Tasks: Member-Update Message Validation

**Input**: `specs/001-member-update-message-validation/spec.md`, `specs/001-member-update-message-validation/plan.md`
**Prerequisites**: `wot-spec/schemas/member-update.schema.json`, `wot-spec/03-wot-sync/005-gruppen.md`, `wot-spec/test-vectors/phase-1-interop.json`

**Tests**: Tests are required for this slice because validation behavior is the acceptance surface.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel when files do not overlap
- **[Story]**: Which user story the task supports
- Include exact file paths in every implementation task

## Phase 1: Setup and Scope

**Purpose**: Confirm normative references and repository scope before implementation.

- [ ] T001 [P] [US1] Read normative message requirements in `/home/fritz/workspace/workspace/wot-spec/schemas/member-update.schema.json` and `/home/fritz/workspace/workspace/wot-spec/03-wot-sync/005-gruppen.md`.
- [ ] T002 [P] [US1] Inspect existing protocol exports in `packages/wot-core/src/protocol/index.ts` and existing interop coverage in `packages/wot-core/tests/ProtocolInterop.test.ts`.
- [ ] T003 [US2] Confirm forbidden scope remains unchanged: `/home/fritz/workspace/workspace/wot-spec/`, `.github/workflows/`, and `apps/`.
- [ ] T003A [P] [US2] Read persistent context in `.specify/memory/constitution.md`, `AGENTS.md`, `docs/architecture/vnext-ts-target.md`, `docs/conformance/ts-implementation-map.md`, `docs/architecture/legacy-retirement.md`, and `docs/automation/tdd-agent-flow.md`.

---

## Phase 2: Tests First

**Purpose**: Capture schema behavior before implementation changes.

- [ ] T004 [US1] Add failing valid-message coverage for `member-update/1.0` in `packages/wot-core/tests/ProtocolInterop.test.ts`.
- [ ] T005 [US1] Add failing invalid-message coverage for wrong `typ`, wrong `type`, invalid action, negative `effectiveKeyGeneration`, and extra body properties in `packages/wot-core/tests/ProtocolInterop.test.ts`.

**Checkpoint**: Tests should fail before implementation if helpers are not present.

---

## Phase 3: Implementation for User Story 1

**Goal**: Export deterministic member-update creation and validation helpers from core protocol code.

- [ ] T006 [US1] Implement `MemberUpdateAction`, `MemberUpdateBody`, `MemberUpdateMessage`, constants, and assertion/parsing helpers in `packages/wot-core/src/protocol/sync/membership-messages.ts`.
- [ ] T007 [US1] Export the member-update helpers through `packages/wot-core/src/protocol/index.ts`.
- [ ] T008 [US1] Ensure validation allows top-level DIDComm extension properties but rejects extra properties inside `body`.

**Checkpoint**: User Story 1 is complete when targeted protocol tests pass.

---

## Phase 4: Conformance Evidence for User Story 2

**Goal**: Make review evidence explicit and keep delivery human-controlled.

- [ ] T009 [US2] Run `pnpm --filter @web_of_trust/core test -- ProtocolInterop`.
- [ ] T010 [US2] Run `pnpm --filter @web_of_trust/core typecheck`.
- [ ] T011 [US2] Run `pnpm --filter @web_of_trust/core build`.
- [ ] T012 [US2] If core output consumed by Vault changes, run `packages/wot-vault/docker-build.sh` and include resulting `packages/wot-vault/wot-core-dist/` updates.
- [ ] T013 [US2] Run `git diff --check`.
- [ ] T014 [US2] Update `docs/conformance/ts-implementation-map.md` to reflect member-update message-validation status, or document why this branch cannot claim it yet.
- [ ] T015 [US2] Update `docs/architecture/legacy-retirement.md` if any legacy membership or sync path was touched, or document no legacy impact.
- [ ] T016 [US2] Stop at human review; do not merge, release, force-push, or bypass hooks.

---

## Dependencies & Execution Order

- Phase 1 must complete before tests or implementation.
- T004 and T005 should be written before T006 through T008.
- T007 depends on T006.
- T009 through T013 run after implementation.
- T014 and T015 run after implementation and before delivery.
- T016 is always required before any delivery action.

## Parallel Opportunities

- T001 and T002 can run in parallel.
- T004 and T005 touch the same test file and should be coordinated by one worker.
- Implementation tasks T006 through T008 should be sequential because they touch related exports and validation semantics.
- Check tasks T009 through T013 can be run by automation after implementation, with failures routed back to the implementer.
- Tracking tasks T014 and T015 can be handled after checks pass, but before PR handoff.

## Human Gates

- Normative `wot-spec` changes require human approval.
- Crypto, DID/JWS, membership removal semantics, authorization, or breaking export changes require human approval.
- No auto-merge or release is allowed from this task list.

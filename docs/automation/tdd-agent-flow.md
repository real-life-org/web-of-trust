# Test-Driven Agent Flow

## Purpose

Spec-to-TypeScript implementation should be test-driven by default. This keeps agents from filling gaps with plausible code that is not anchored in `wot-spec` behavior.

## Default Cycle

For behavior-changing slices, use red-green-refactor:

1. Red: add or update the smallest test that expresses the spec requirement, vector, schema behavior, or application rule.
2. Verify red: run the targeted command and confirm the new test fails for the expected reason.
3. Green: implement the smallest production change that makes the test pass.
4. Refactor: clean up without changing behavior.
5. Evidence: run all task checks and update conformance/legacy tracking.

Docs-only and pure infrastructure slices may skip red-green-refactor, but the PR must say why.

## Test Layer Selection

| Slice Type | First Test Location | Example Command |
|---|---|---|
| Protocol vector/schema behavior | `packages/wot-core/tests/ProtocolInterop.test.ts` or focused protocol test | `pnpm --filter @web_of_trust/core test -- ProtocolInterop` |
| Application workflow | `packages/wot-core/tests/*Workflow.test.ts` with fake ports | `pnpm --filter @web_of_trust/core test -- <WorkflowTest>` |
| Adapter behavior | adapter contract or adapter-specific test | `pnpm --filter @web_of_trust/core test -- <AdapterTest>` |
| React hook behavior | hook test near demo or future react package | package-specific test command |
| End-to-end user journey | minimal Playwright smoke | repository E2E command documented in the task |

## Agent Requirements

Implementer prompts must include:

- The normative spec reference.
- The intended test layer.
- The red-phase command.
- The green-phase checks.
- Required conformance-map and legacy-map updates.

Implementers must not skip directly to production code when the slice changes behavior.

## Reviewer Requirements

Reviewers must check:

- Did the PR add or update a meaningful test before relying on implementation code?
- Does the test fail on the old behavior or is there a clear reason red-phase evidence is unavailable?
- Are assertions tied to spec behavior instead of implementation details?
- Are conformance and legacy maps updated consistently?
- Did generated or vendored artifacts change only through the documented build path?

## Runner Evidence

Until the runner has a separate automated test-writer phase, TDD evidence is textual and check-based:

- `tasks.md` must contain test-first tasks before implementation tasks.
- The PR body or Agent Runner Summary must list the intended red-phase command.
- The final checks must include the relevant targeted test command.
- Reviewer findings should request changes when behavior changed without meaningful tests.

Future runner hardening should split behavior-changing slices into two worker phases:

- Test writer phase: add tests only, then run red checks expected to fail.
- Implementer phase: make those tests pass, then run the full check set.

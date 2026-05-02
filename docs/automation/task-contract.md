# Agent Task Contract

Status: operational, non-normative.

An agent task contract is the smallest unit of autonomous work. It tells an agent what to do, what not to touch, how to verify the result, and when to stop for a human gate.

## Required Shape

```yaml
id: agent-review-gh-auth-error
title: Improve gh authentication error for PR review packets
repo: web-of-trust
base: spec-vnext
type: fix
priority: medium
goal: >
  Make agent-review-pr report an actionable error when the GitHub CLI is not
  authenticated, without changing successful review packet output.
spec_refs:
  - docs/PROJECT-FLOW.md
  - docs/automation/pr-review-rubric.md
allowed_scope:
  - scripts/agent-review-pr.mjs
  - docs/PROJECT-FLOW.md
forbidden_scope:
  - packages
  - GitHub Actions workflows
acceptance:
  - gh authentication failures mention `gh auth login`.
  - Successful review packet output keeps the same markdown sections.
  - Help output remains unchanged except for intentional wording updates.
checks:
  - node --check scripts/agent-review-pr.mjs
  - pnpm agent:review-pr --help
reviewers:
  - architecture
  - tests
human_gates:
  - Posting comments to GitHub automatically
  - Adding or changing CI workflows
notes: []
```

## Field Rules

| Field | Rule |
| --- | --- |
| `id` | Stable kebab-case identifier. |
| `repo` | Repository that receives the branch. |
| `base` | Base branch for the task branch. |
| `type` | One of `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `release`, `research`. |
| `goal` | One outcome, not a bundle of unrelated work. |
| `spec_refs` | Files, PRs, issues, or decisions that constrain the task. |
| `allowed_scope` | Paths the agent may change without asking. |
| `forbidden_scope` | Paths or behaviors that require human approval. |
| `acceptance` | Observable outcomes reviewers can verify. |
| `checks` | Commands the implementer must run when feasible. |
| `reviewers` | Review roles required before integration. |
| `human_gates` | Conditions that stop automation. |

## Splitting Large Work

A task contract should be small enough for one focused PR. If a change would touch multiple layers or produce a large diff, split it before implementation.

For example, an SDK-boundary refactor should become multiple contracts:

- Move interfaces from `adapters/interfaces` to `ports` and update direct imports.
- Extract `IdentitySession` types to a neutral `types` module.
- Add package subpath exports and multi-entry build output.
- Migrate demo and adapter consumers to subpath imports.
- Refresh vendored distribution artifacts and verify downstream packages.

Each split task gets its own acceptance criteria, checks, and PR. A later integration PR may collect them only when the intermediate PRs are reviewed and green.

## Stop Conditions

The implementer must stop and report when:

- A human gate is triggered.
- Required checks cannot run locally.
- The allowed scope is insufficient.
- The task conflicts with unrelated worktree changes.
- The spec reference is ambiguous or contradictory.
- The implementation would require a larger architectural decision than the contract allows.

## Completion Criteria

A task is complete when:

- The branch contains only task-scoped changes.
- Acceptance criteria are satisfied or explicitly marked as blocked.
- Required checks ran or are documented as unavailable.
- A PR exists with a summary, verification list, and residual risks.
- Automated review packets have been generated or requested.

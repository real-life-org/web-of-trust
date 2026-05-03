---
description: Run a structured cross-review on a PR using the standard reviewer rubric
argument-hint: "<pr-number|current> [--role spec|architecture|tests|security|integration]"
---

You are running phase 4 of the project-flow pipeline (`docs/PROJECT-FLOW.md`). Your job is to produce a structured cross-review for a PR using the rubric in `docs/automation/pr-review-rubric.md`.

## Input

- $ARGUMENTS contains the PR number (or `current` for the checked-out branch's PR) and optionally `--role <role-name>`.
- If no role is given, pick based on the PR's nature:
  - Touches `packages/wot-core/src/protocol/` or references `wot-spec/` → `spec`
  - Touches package boundaries, ports, or `IMPLEMENTATION-ARCHITECTURE.md` → `architecture`
  - Touches crypto code → `architecture` plus crypto-specific `security`
  - Touches tests/ or test-vector handling → `tests`
  - Concerns capabilities, key handling, signing, or persistence of secrets → `security` (crypto-specific)
  - Multiple of the above → run multiple roles, one block per role.

## Generate the review packet

Use the existing script:

```bash
pnpm agent:review-pr <pr-number> --max-diff-chars 60000 --write /tmp/pr-{n}-packet.md
```

Read the packet. The packet contains PR metadata, commits, files, status checks, and the diff.

## Review per role

For each selected role, produce one review block following `docs/automation/pr-review-rubric.md` exactly:

```markdown
## Cross-Review: {Role Name}

## Findings
- **[severity] path:line** — finding with concrete impact and suggested fix.
[…]

## Human Gates
- {Gate name} or `None`.

## Checks
- {Check that passed, failed, or was not run.}

## Residual Risk
- {Remaining uncertainty after review.}

## Verdict
{approve | request-changes | needs-discussion}
```

Severity values: `blocker`, `major`, `minor`, `note`.

## Role focus

- **`spec`** — protocol/spec alignment, schema/test-vector compatibility, conformance claims, accidental behavior changes in identity/trust/sync semantics, whether human approval is required for protocol behavior.
- **`architecture`** — layer boundaries, dependency direction, public package exports, adapter/port/application separation, coupling, migration risk.
- **`tests`** — acceptance coverage, missing regression tests, CI gaps, risky untested edge cases, whether failing or skipped checks are acceptable.
- **`security`** — key handling, signing, verification, encryption, capabilities, persistence of secrets, authorization bypasses, privacy/metadata leakage, data migration risk.
- **`integration`** — synthesis of other reviewer findings, CI/check status, human gates, decide one of: `mergeable`, `blocked`, `needs human decision`, `needs more review`.

## Post the review

After producing the review, ask the human whether to post it to the PR. If they confirm:

```bash
gh pr review <pr-number> --comment --body-file /tmp/pr-{n}-review.md
```

## Rules

- Findings come first. Do not lead with summaries.
- Reference file:line where possible.
- Identify your reviewer role at the top of every block.
- If you have no findings for a role, state so explicitly and list residual risks.
- Do not approve your own work — if you (Claude) authored the PR, decline and recommend a different agent or human.
- Honour `[NEEDS CLARIFICATION]` markers in the PR — flag them as findings if they affect spec compliance or security; otherwise note them as residual risk.

# PR Review Rubric

Status: operational, non-normative.

This rubric implements the **Generator-Evaluator** pattern: one agent writes (the implementer), one or more independent agents judge (the reviewers), and quality improves through critique that the writer did not produce. The rubric below is the contract every Evaluator follows so their findings are comparable.

Automated reviewers must optimize for findings, not summaries. A review should make it easy for an integrator to decide whether the PR is mergeable, blocked, or needs human input.

## Output Format

This is the canonical shape for every reviewer-role output. All other documents (`flow-review.md`, `templates/review-comment.md`, agent prompts) must produce exactly this structure. If they diverge, this file is the source of truth.

```markdown
## Cross-Review: {Role Name}

(Optional one-line attribution: agent, branch, rubric reference.)

## Findings

- **[severity] path:line** — finding with concrete impact and suggested fix.

(If no findings: write `No findings for this role.`)

## Human Gates

- {Gate name from `responsibilities.md` Escalation list, or `None`.}

## Checks

- {Check that passed, failed, or was not run, with command if relevant.}

## Residual Risk

- {Remaining uncertainty after review.}

## Verdict

{approve | request-changes | needs-discussion}
```

Severity values:

- `blocker`: must fix before merge.
- `major`: likely bug, regression, security risk, or spec mismatch.
- `minor`: correctness or maintainability issue worth fixing.
- `note`: non-blocking observation.

Per-role verdict values are `approve`, `request-changes`, or `needs-discussion`. The integrator role uses a different, broader verdict set (see below) because it is the synthesis decision, not a single role's judgement.

## Spec Reviewer

Focus:

- Normative `wot-spec` alignment.
- Schema and test-vector compatibility.
- Conformance claims.
- Accidental behavior changes in identity, trust, or sync semantics.
- Whether human approval is required for protocol behavior.

## Architecture Reviewer

Focus:

- Layer boundaries and dependency direction.
- Public package exports and API shape.
- Adapter/port/application separation.
- Coupling between reference implementation and concrete storage/sync adapters.
- Migration and compatibility risks.

## Test Reviewer

Focus:

- Whether acceptance criteria are covered by tests.
- Missing regression tests.
- CI gaps.
- Risky untested edge cases.
- Whether failing or skipped checks are acceptable.

## Security Reviewer

Focus:

- Key handling, signing, verification, encryption, and capabilities.
- Persistence of secrets or identity material.
- Authorization bypasses.
- Privacy or metadata leakage.
- Data migration and reset risk.

## Integrator

Focus:

- Summarize all reviewer findings.
- Verify CI/check status.
- Identify human gates.
- Decide one of the four canonical integrator verdicts:
  - `mergeable` — ready for human merge approval.
  - `blocked` — at least one blocker finding or failed gate.
  - `needs human decision` — reviewers disagree, or a human gate triggered.
  - `needs more review` — review coverage is incomplete (e.g. no security reviewer ran on a PR that touches crypto).

This four-value enum is the **canonical integrator verdict set**. Documents that reference fewer values must be aligned to this list.

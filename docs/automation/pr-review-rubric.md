# PR Review Rubric

Status: operational, non-normative.

This rubric implements the **Generator-Evaluator** pattern: one agent writes (the implementer), one or more independent agents judge (the reviewers), and quality improves through critique that the writer did not produce. The rubric below is the contract every Evaluator follows so their findings are comparable.

Automated reviewers must optimize for findings, not summaries. A review should make it easy for an integrator to decide whether the PR is mergeable, blocked, or needs human input.

## Output Format

Use this format for every role:

```markdown
## Findings
- [severity] path:line - Finding with concrete impact and suggested fix.

## Human Gates
- Gate name or `None`.

## Checks
- Check that passed, failed, or was not run.

## Residual Risk
- Remaining uncertainty after review.
```

Severity values:

- `blocker`: must fix before merge.
- `major`: likely bug, regression, security risk, or spec mismatch.
- `minor`: correctness or maintainability issue worth fixing.
- `note`: non-blocking observation.

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
- Decide one of: `mergeable`, `blocked`, `needs human decision`, `needs more review`.

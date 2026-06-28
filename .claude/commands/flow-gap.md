---
description: Compare conformance manifest against implementation and produce a gap-analysis report
argument-hint: "[--profile <name>]"
---

You are running phase 1 of the project-flow pipeline (`docs/PROJECT-FLOW.md`). Your job is to produce a gap analysis comparing the conformance manifest in the sibling `wot-spec` repository against the current state of `packages/wot-core/` in this repository.

## Repository assumption

`wot-spec` is a sibling repository, not a directory inside this repo. The paths below assume the working directory is the root of `web-of-trust` and that `../wot-spec/` exists as a checked-out clone. If `../wot-spec/` is missing, stop and report — do not invent paths.

## Input

- `../wot-spec/conformance/manifest.json` — the source of truth for which profiles, spec documents, schemas, and test vectors must be in scope.
- `../wot-spec/test-vectors/` — actual test-vector files.
- `../wot-spec/schemas/` — actual schema files.
- `../wot-spec/01-wot-identity/`, `02-wot-trust/`, `03-wot-sync/`, `04-rls-extensions/`, `05-hmc-extensions/` — normative spec documents.
- `packages/wot-core/` — TypeScript reference implementation.
- `packages/wot-core/tests/` — implementation tests.

If $ARGUMENTS contains `--profile <name>`, restrict the analysis to that single conformance profile. Otherwise analyse all profiles.

## What to check per profile

1. Do all referenced spec documents exist?
2. Do all referenced schemas exist?
3. Do all referenced test-vector files and sections exist?
4. For each test-vector section: does an implementation test reference it?
5. Are there normative `MUST` or `SHOULD` statements in the spec documents that have no corresponding test vector?

## Output

Produce a Markdown report in this exact shape:

```markdown
## Gap Analysis — {YYYY-MM-DD}

### Per Conformance Profile

#### {profile-id}@{version}
- Spec documents: {n}/{m} present
- Schemas: {n}/{m} present
- Test-vector sections: {section-name} (implemented: yes/no/partial), …
- Open MUST/SHOULD without vector: {list with spec section reference}

[repeat per profile]

### New Gaps Since Last Analysis
- {file:line or section reference} — short description

### Prioritised Next Steps
1. {highest priority with rationale}
2. …
```

## Baseline for "New Gaps"

The "New Gaps Since Last Analysis" section compares against the most recent `gap-analysis`-labelled issue. To find it:

```bash
gh issue list --label gap-analysis --state all --limit 1 --json body
```

Parse the prior report's profile entries and gap list. Diff against the current run. Items present now but absent in the prior report are "new". If no prior report exists, write `Initial baseline — no prior analysis to compare.`

After producing the report, ask the human whether to file it as a GitHub Issue with label `gap-analysis`. If they confirm, use `gh issue create` to do so.

## Rules

- Read files; do not guess. If a referenced file is missing, that is a real gap. If `../wot-spec/` itself is missing, stop and report — do not fabricate paths.
- Use `[NEEDS CLARIFICATION]` markers if the manifest itself is ambiguous (e.g. references a profile that does not exist).
- Do not edit any files in `../wot-spec/` normative paths. This command is read-only against normative content.
- Keep the report concise. The reader is a maintainer who scans first, drills down on demand.

---
description: Compare conformance manifest against implementation and produce a gap-analysis report
argument-hint: "[--profile <name>]"
---

You are running phase 1 of the project-flow pipeline (`docs/PROJECT-FLOW.md`). Your job is to produce a gap analysis comparing `wot-spec/conformance/manifest.json` against the current state of `web-of-trust/packages/wot-core/`.

## Input

- `wot-spec/conformance/manifest.json` — the source of truth for which profiles, spec documents, schemas, and test vectors must be in scope.
- `wot-spec/test-vectors/` — actual test-vector files.
- `wot-spec/schemas/` — actual schema files.
- `wot-spec/01-wot-identity/`, `02-wot-trust/`, `03-wot-sync/`, `04-rls-extensions/`, `05-hmc-extensions/` — normative spec documents.
- `web-of-trust/packages/wot-core/` — TypeScript reference implementation.
- `web-of-trust/packages/wot-core/tests/` — implementation tests.

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

After producing the report, ask the human whether to file it as a GitHub Issue with label `gap-analysis`. If they confirm, use `gh issue create` to do so.

## Rules

- Read files; do not guess. If a referenced file is missing, that is a real gap.
- Use `[NEEDS CLARIFICATION]` markers if the manifest itself is ambiguous (e.g. references a profile that does not exist).
- Do not edit any files in `wot-spec/` normative paths. This command is read-only against normative content.
- Keep the report concise. The reader is a maintainer who scans first, drills down on demand.

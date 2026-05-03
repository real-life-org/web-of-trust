---
description: Generate the weekly State-of-Project dashboard for human review
---

You are generating the State-of-Project dashboard described in `docs/automation/local-pipeline.md` and `wot-spec/research/autonomous-pipeline.md`. This is the document the human Primary Maintainer reads weekly to keep oversight without reviewing every PR.

## Output structure

Produce a single Markdown document in this exact shape, then ask whether to write it to `~/.local/share/wot-pipeline/state/{YYYY-MM-DD}-state.md` (or wherever the maintainer prefers).

```markdown
# State of Project — {YYYY-MM-DD}

## Conformance Status

For each profile in `wot-spec/conformance/manifest.json`:
- `{profile-id}@{version}`: {n}/{m} test-vector sections green ({percent}%)

Trend: {improved | stable | regressed} since last week.

## Spec Coverage

- MUST/SHOULD anchors with test vectors: {n}/{m}
- Open `spec-gap` issues: {n}

## Architecture Footprint Diff (this week)

Changes to architectural boundaries since last week's snapshot:
- New layers / packages: {list or "none"}
- New external dependencies: {list with rationale or "none"}
- Public API additions or removals: {list or "none"}

## Pipeline Activity

- PRs opened: {n}
- PRs merged: {n}
- Avg time to merge (merged this week): {hours}
- PRs blocked: {n} (link each)
- PRs needs-discussion: {n} (link each)

## Drift Indicators

Files changed unexpectedly often or in unexpected locations. List the top 3-5 hotspots with one-line rationale ("expected vs. unexpected").

## Open Items Requiring Human Attention

- {Items with `needs-human` label}
- {Items with `blocked` label that have not had attention in 7+ days}
- {`spec-gap` issues older than 14 days}

## Conformance Regressions

Tests that turned red this week, with commit reference. Empty list is the goal.

## Reflection Prompts

Three questions for the maintainer's Sunday evening reading:

1. Is the pipeline producing more output than I can supervise?
2. Are there spec-gap issues that have been open too long, suggesting an underlying ambiguity I have not surfaced?
3. Did anything surprise me this week that I should write into a memory or feedback file?
```

## How to gather the data

- **Conformance status**: run `pnpm --filter @web_of_trust/core test` if not too slow; otherwise read the latest CI run via `gh run list --limit 1`.
- **Spec coverage**: grep MUST/SHOULD in `wot-spec/01-`, `02-`, `03-`, `04-`, `05-` and cross-reference with test-vector files.
- **Architecture diff**: `git log --since="7 days ago" --diff-filter=A --name-only` for new files; cross-reference with `IMPLEMENTATION-ARCHITECTURE.md` layer rules.
- **Pipeline activity**: `gh pr list --state all --search "merged:>{date}"`, `gh pr list --label blocked`, etc.
- **Drift indicators**: `git log --since="7 days ago" --name-only --pretty=format: | sort | uniq -c | sort -rn | head`.
- **Open items**: `gh issue list --label needs-human`, etc.
- **Conformance regressions**: compare current `pnpm test` output against the previous week's stored result.

## Rules

- Concise. The reader has 30 minutes Sunday evening, not three hours.
- Numbers come first, narrative second.
- Reflection prompts at the bottom — they are for the human to think with, not for the dashboard to answer.
- If a section has nothing to report, write "No notable items." Do not pad.
- Never include `[NEEDS CLARIFICATION]` markers in this output — if data is missing, fetch it or omit the line. The dashboard is a snapshot, not a draft.

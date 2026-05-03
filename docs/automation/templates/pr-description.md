# PR Description Template

Used by both human and agent PR authors. Keep sections short, evidence-based.

```markdown
## Summary

{1-3 bullet points. What changed, in plain language.}

## Contract

**Task contract:** [`docs/automation/tasks/{id}.yaml`](docs/automation/tasks/{id}.yaml) (or `none — manual change`)
**Closes:** #{issue-number} (if applicable)

## Verification

- [ ] {Each contract `check` with its result}
- [ ] {Manual verification steps if any}

Example:
- `pnpm --filter @web_of_trust/core typecheck` — pass
- `pnpm --filter @web_of_trust/core test` — pass (329/329)
- `git diff --check` — clean

## Clarifications Needed

List every `[NEEDS CLARIFICATION]` marker added in this PR. If none: write "None."

Example:
- `packages/wot-core/src/sync/retry.ts:42` — spec mentions retry but no upper bound; chose 3.
- `packages/wot-core/src/crypto/nonce.ts:18` — section 003-sync.md says "12 or 16 bytes"; chose 12 (IETF default).

## Residual Risk

{What might still go wrong after this merges. Things you considered but did not fully verify.}

If you don't know any: write "None known. Reviewer please look for what I missed."

## Reviewer Notes

{Anything specific to call out — files to read first, edge cases that matter, why a non-obvious choice was made. Skip if not needed.}
```

## Rules

- The PR description is the durable record of the change. Commit messages are too terse, comments too scattered.
- Verification must list real outputs, not aspirations. If a check did not run, say so.
- Clarifications are a first-class section, not a footnote. Reviewers must explicitly acknowledge each one.
- Residual risk is the section reviewers thank you for. Be honest — there is always something.
- For PRs from autonomous task execution: this template is mandatory. For PRs from synchronous human-supervised work: optional but recommended.

# Issue Template: Spec Gap

Used when an agent or reviewer finds an ambiguity, omission, or contradiction in normative `wot-spec/` content that requires synchronous human resolution. Apply label `spec-gap`.

```markdown
## Spec Gap

**Spec reference:** {file path and section number}
**Discovered during:** {task contract id, PR number, or "review of <PR>"}

## What is unclear

{Concise description of the gap. Quote the relevant spec text verbatim.}

## Why it matters

{What an implementer cannot proceed with. What two reasonable readings would produce different protocol behavior.}

## Possible resolutions

- {Option A — implications}
- {Option B — implications}
- {Option C if applicable}

## Workaround in current implementation

{How the current code handles this — typically a `[NEEDS CLARIFICATION]` marker. Reference the file:line.}

## Recommendation

{If the proposer has a recommendation, state it. If genuinely undecided, say so.}
```

## Rules

- One gap per issue. Do not bundle.
- Quote spec text verbatim — paraphrasing risks reintroducing the ambiguity.
- The issue must be resolvable in a synchronous spec-authoring session. If the gap is too large for one session, split it.
- Resolution always happens in a synchronous human-supervised session per Hard Rule 1, never via autonomous task contract.
- After resolution: close the issue with a reference to the spec change PR and the matching `[NEEDS CLARIFICATION]` marker removal.

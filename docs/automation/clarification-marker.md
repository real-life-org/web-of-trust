# Clarification Marker Convention

Status: operational, non-normative.

When an agent encounters ambiguity it cannot resolve from the spec, the architecture docs, or the task contract, it MUST mark the ambiguity explicitly rather than guess plausibly. This is **question generation** applied at implementation time — interview-first, implement-second — and prevents the most common LLM failure mode: confidently filling gaps incorrectly.

## The Marker

Use the inline marker `[NEEDS CLARIFICATION: question]` directly where the ambiguity occurs. Markers are appropriate for **local, non-normative** decisions where the spec is genuinely silent and the choice does not change protocol behavior. For ambiguities that affect normative behavior (crypto parameters, signature semantics, encoding rules, sync ordering), do not pick a value — file a `spec-gap` issue and stop. See "When NOT to Use the Marker" below.

Examples — appropriate (local, non-normative scope):

```typescript
// in code — local UI/UX behavior, not protocol-affecting
const profileFetchTimeoutMs = 5_000 // [NEEDS CLARIFICATION: spec is silent on UX timeout for the profile-loading skeleton. 5s seems reasonable for first paint.]

const debugLogRetentionDays = 7 // [NEEDS CLARIFICATION: spec does not address local debug log retention. Defaulting to 7 days; this is a UX choice, not a protocol parameter.]
```

```markdown
<!-- in docs — annotation an author is unsure about -->
The onboarding flow shows three [NEEDS CLARIFICATION: should this be a fixed three-step tour, or expandable per locale? Asking the design owner.] checkpoints.
```

Counter-examples — **NOT appropriate**, file `spec-gap` instead:

```typescript
// WRONG — TTL on protocol caches affects interop
const cacheTtlMs = 60_000 // do NOT pick this. Stop and file a spec-gap.

// WRONG — nonce size is a normative crypto parameter
const nonceSize = 12 // do NOT pick this. Stop and file a spec-gap.

// WRONG — retry policy can be observable from peers
const maxRetries = 3 // do NOT pick this. Stop and file a spec-gap.
```

## Where Markers Belong

- **In the implementation file** where the decision was made.
- **In the PR description** under a "Clarifications Needed" section, listing each marker with file:line reference.
- **In the task contract notes** if the task itself was ambiguous.

The PR description summary is the most important — that's where the human reviewer sees them at a glance.

## What the Marker Means for the Reviewer

A PR with `[NEEDS CLARIFICATION]` markers is not blocked, but it shifts review focus. The cross-reviewer agent should:

1. Check whether the spec actually clarifies the question (the implementer might have missed it).
2. Recommend a resolution if the spec is genuinely silent.
3. Suggest opening a `spec-gap` issue if the resolution requires normative spec change.

The integrator decision must explicitly acknowledge each marker — none should be silently merged.

## When NOT to Use the Marker

- For minor style choices (variable naming, formatting): just decide, no marker needed.
- For ambiguities that are *answered* in the spec but the agent missed: this is implementation error, not ambiguity. Re-read the spec instead of marking.
- As an excuse for not reading the spec carefully: markers are for genuine gaps, not for skipping research.

## Resolution Lifecycle

1. **Marker created** — agent adds inline marker plus PR description entry.
2. **Reviewer triages** — cross-review confirms the ambiguity is real.
3. **Resolution path** — one of:
   - Spec is actually clear → remove marker, fix the implementation.
   - Spec is silent and decision is local-scope → human approves the chosen value, marker stays as a code comment with the rationale.
   - Spec is silent and decision is normative → open `spec-gap` issue, block the PR, resolve in synchronous spec-authoring session.
4. **Merge** — markers in the merged code are acceptable only if they document a justified local decision. Normative gaps must be resolved before merge.

## Why This Matters

LLMs default to plausible completion. When a spec says "the timeout is reasonable," the agent will pick a number — and write code that looks correct. The wrong choice can hide for months until interop testing reveals it.

The marker forces the agent to declare its uncertainty. The cost is a few visible TODOs; the benefit is that no agent silently invents protocol behavior.

This is a hard rule for spec-driven work, not a style preference.

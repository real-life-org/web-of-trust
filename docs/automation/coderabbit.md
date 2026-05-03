# CodeRabbit Integration

Status: operational, non-normative.

CodeRabbit is a third-party AI code reviewer that runs as a GitHub App. It is free for public repositories with no PR limit. We use it as one of three reviewer agents alongside Claude and Codex.

## Why CodeRabbit

- **24/7 availability.** Runs on GitHub's side, independent of any laptop. PRs opened overnight already have a baseline review by morning.
- **Different focus.** CodeRabbit specialises in code quality, anti-patterns, and generic security (SAST, OWASP, dependency scans). Claude and Codex specialise in spec compliance and architecture. Three independent reviewers with different strengths catch more.
- **Cost.** Free for public repos. Does not consume our Claude Max or ChatGPT Pro quotas.
- **GitHub-native.** Inline comments, summaries, follow-up commits — the standard PR review surface.

## Role Mapping

CodeRabbit fits the reviewer-role model from `pr-review-rubric.md` like this:

| Role | Primary | Secondary |
| --- | --- | --- |
| `spec` | Claude | — |
| `architecture` | Claude | — |
| `tests` | Codex | CodeRabbit |
| `security` (baseline / generic) | CodeRabbit | Claude |
| `security` (crypto-specific) | Claude | — |
| `integration` (synthesis) | Claude | — |

CodeRabbit is the lead for the generic security baseline because it has dedicated SAST and dependency scanning. Claude remains the lead for crypto-specific security because it understands our ECIES/Ed25519/X25519/JWS choices and the project's threat model.

## What CodeRabbit Cannot Do

- **Spec compliance.** CodeRabbit does not know `wot-spec/`. It will not say "this contradicts Section 003-sync.md test vector ecies".
- **Architecture context.** CodeRabbit sees a PR in isolation, not as part of the layer-migration story in `IMPLEMENTATION-ARCHITECTURE.md`.
- **Crypto-specific reasoning.** Generic SAST flags obvious issues but cannot reason about whether our key derivation matches the spec.

These gaps are why we still run Claude and Codex reviews. CodeRabbit is a reviewer, not the only reviewer.

## Configuration

The repo ships a template at `.coderabbit.example.yaml`. CodeRabbit only reads `.coderabbit.yaml` at the repo root, so the template is inert until copied. This separation keeps the PR documentation-only until activation is explicitly approved.

Key settings in the template:

- **Path filters** — skip generated artifacts (e.g. `packages/wot-vault/wot-core-dist/`) and lock files.
- **Path instructions** — tell CodeRabbit *what it can actually verify* per path: missing references, risky changes, code-level inconsistencies. The instructions explicitly avoid asking CodeRabbit to verify spec compliance, since it does not know `wot-spec`.
- **Auto review** — run on every PR, including drafts (early signal).
- **Tool allowlist** — linters and SAST tools that match our TypeScript/ESLint stack.

See the inline comments in `.coderabbit.example.yaml` for the rationale.

## Activation

Activation is a human gate. Anton (or a designated maintainer) decides when CodeRabbit goes live, then runs:

1. Copy the template to the active path:

   ```bash
   cp .coderabbit.example.yaml .coderabbit.yaml
   ```

   Commit and push as a separate, single-purpose PR titled `chore: activate CodeRabbit`. Review the diff to confirm the active config matches the template.

2. Sign in at <https://coderabbit.ai/login> with the GitHub account that owns or has admin on the org.

3. Authorise the org and select repositories: `web-of-trust`, optionally `wot-spec` and `real-life-stack`.

4. Verify by opening a draft PR — CodeRabbit posts an initial summary within minutes.

Setup is reversible in two steps:

- Remove `.coderabbit.yaml` (config-level disable, keeps the App authorised).
- Revoke the GitHub App authorisation (full disable).

The two-step model means a noisy CodeRabbit can be silenced via repo PR without going to org settings.

## Review Flow With CodeRabbit Active

```
PR opened
  |
  v
CodeRabbit auto-review (within minutes, GitHub-side)
  |
  v
Local script triggers Claude review (spec + architecture + crypto + integration)
  |
  v
Local script triggers Codex review (tests)
  |
  v
All three reviewer outputs visible on PR
  |
  v
Anton (or domain owner) decides merge
```

CodeRabbit's review is the entry signal. The local Claude and Codex passes add the spec-aware depth that CodeRabbit cannot provide.

## Failure Modes

- **CodeRabbit posts a noisy review with low-signal nits.** Tighten `.coderabbit.yaml` path filters and review level. Worst case: disable on specific paths.
- **CodeRabbit and Claude disagree on a finding.** Treat as a normal `needs-discussion` case. The disagreement itself is signal — usually one reviewer has context the other lacks.
- **CodeRabbit unavailable.** Pipeline degrades gracefully — Claude and Codex reviews still run. Block on no reviewer is never required; missing one means the integration verdict notes which reviewers ran.

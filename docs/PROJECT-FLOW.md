# Project Flow Automation

Status: operational, non-normative.

This document defines how the Web of Trust project should move from human-driven, ad-hoc agent work toward reproducible spec-driven automation. The goal is not full autonomy first. The goal is a reliable workflow where agents can plan, implement, review, and integrate small slices while humans keep control of product, protocol, security, and release decisions.

Source concept: `wot-spec/research/autonomous-pipeline.md` describes the broader non-normative pipeline vision: conformance watcher, gap analysis, task generation, implementation, cross-review, human gate, and feedback loop. This document is the operational layer for the TypeScript reference implementation: concrete task-contract shape, review rubric, and local tooling.

Related operational docs in `docs/automation/`:

- `task-contract.md` plus `task-contract.schema.json` — format for a single slice of agent work.
- `pr-review-rubric.md` — standard output format every reviewer role produces.
- `clarification-marker.md` — convention for marking ambiguities agents encounter (`[NEEDS CLARIFICATION]`).
- `responsibilities.md` — who does what (humans and agents).
- `coderabbit.md` — how the third-party reviewer slots into the role model.
- `local-pipeline.md` — local-vs-remote split and bootstrap order for orchestrator scripts.
- `tasks/` — the durable YAML contracts.
- `templates/` — issue, PR, and review templates that produce reproducible artifacts.

Slash commands for Claude Code live in `.claude/commands/`. They share the `/flow-` prefix to keep pipeline operations grouped and discoverable via tab-completion:

- `/flow-gap` — phase 1, conformance manifest vs implementation.
- `/flow-task` — phase 3, autonomous execution of a task contract.
- `/flow-review` — phase 4, structured cross-review of a PR.
- `/flow-state` — weekly State-of-Project dashboard for the maintainer.

## Goals

- Keep `wot-spec` as the normative source of truth.
- Keep `web-of-trust` as the TypeScript reference implementation.
- Turn GitHub issues and pull requests into the project work queue.
- Make every agent task small, reviewable, and traceable to a task contract.
- Automate cross-review between agents before human review.
- Reserve human attention for protocol decisions, security decisions, release gates, and conflicts.

## Sources Of Truth

| Level | Source | Purpose |
| --- | --- | --- |
| Vision | project manifest, README, roadmap | Direction and principles |
| Normative protocol | `wot-spec` numbered documents, schemas, test vectors, `CONFORMANCE.md` | What implementations must do |
| Implementation architecture | implementation architecture docs and package boundaries | How the TypeScript reference maps protocol to layers |
| Task contract | `docs/automation/task-contract.md` | What one agent task may change |
| Pull request | GitHub PR body, commits, checks, review comments | Reviewable implementation record |
| Release notes | changelog, release PR, deployment notes | What users/operators receive |

## Specification Levels

The project needs several specification layers instead of one giant spec.

| Layer | Example output | Owner |
| --- | --- | --- |
| Protocol spec | Identity, Trust, Sync normative docs | Human gate plus spec reviewer |
| Architecture spec | SDK layers, storage model, sync model | Human gate plus architecture reviewer |
| Slice spec | One task contract | Planner agent, approved by human when high risk |
| Implementation spec | PR description and acceptance criteria | Implementer agent |
| Review spec | Review rubric and generated review prompts | Reviewer agents |
| Release spec | Version, migration, deployment, reset plan | Human gate plus integrator agent |

## Flow

The flow is a **steering loop**: act, sense, decide, adjust. Each pipeline run feeds signal back into the next via merged code, opened spec-gap issues, and updated task contracts. The seven phases below are one turn of that loop.

1. Intake

   A human, planner agent, or reviewer identifies work from specs, PR review, CI, or roadmap.

2. Task contract

   The work is reduced to one small contract with goal, scope, spec references, acceptance criteria, checks, and human gates.

3. Implementation

   An implementer agent creates a branch, changes code/docs, runs required checks, and opens a PR.

4. Automated review

   Reviewer agents inspect the PR using stable rubrics: spec compliance, architecture boundaries, tests/regression, and security.

5. Integration decision

   The integrator checks CI, conflicts, review findings, and whether human gates were triggered.

6. Human gate

   A human decides only when the task changes protocol behavior, security guarantees, release/reset plans, user-visible product decisions, or merge eligibility.

7. Merge and release

   The PR is merged only after checks and gates pass. Release work uses a separate release contract.

## Agent Roles

| Role | Responsibility | May write code? |
| --- | --- | --- |
| Planner | Creates or updates task contracts and next-action summaries | No by default |
| Implementer | Executes one task contract on one branch | Yes |
| Spec reviewer | Checks protocol/spec alignment | No |
| Architecture reviewer | Checks layers, imports, boundaries, coupling, migration risk | No |
| Test reviewer | Checks tests, conformance, regression coverage, CI gaps | No |
| Security reviewer | Checks crypto, auth, identity, privacy, data migration risk | No |
| Integrator | Summarizes readiness, blockers, human gates, merge risk | No |

## Human Gates

Agents must stop and ask for human approval when a task involves any of these:

- Normative protocol behavior.
- Cryptographic primitives, key derivation, signature semantics, capability semantics, or verification rules.
- Persistent data migration, reset plans, or backward compatibility commitments.
- Public API breaking changes.
- Production deployment, release, or merge to the main branch.
- Conflicting changes from another person or agent.
- Ambiguous product behavior.

## Branch And PR Rules

- One task contract should produce one branch and one PR.
- Branch names should start with the work type: `feat/`, `fix/`, `refactor/`, `docs/`, `chore/`.
- PRs should mention the task contract or include its essential fields inline.
- Generated review comments must identify the reviewer role and input PR.
- Agents must not merge their own PRs.
- Agents must not force-push shared branches unless a human explicitly approves it.

## Automation Levels

| Level | Description | First tool |
| --- | --- | --- |
| 0 | Human asks agents manually | Current workflow |
| 1 | Scripts generate stable PR context and reviewer prompts | `pnpm agent:review-pr` |
| 2 | CI posts automated review packets/comments | GitHub Actions plus `gh` |
| 3 | Queue runner assigns task contracts to local/API agents | Local runner or server runner |
| 4 | Integrator proposes merge candidates and release plans | Human-gated automation |

The current implementation starts at level 1. That is intentional: reproducible input and stable rubrics come before autonomous execution.

## First Commands

Generate a review packet for an open PR:

```bash
pnpm agent:review-pr 8 --write /tmp/wot-pr-8-review.md
```

Generate a smaller packet for pasting into another agent:

```bash
pnpm agent:review-pr 8 --max-diff-chars 20000
```

Use the output as the exact prompt/context for Claude, Codex, or another reviewer. If the reviewer finds issues, post a GitHub review or PR comment with the role name and findings.

## Near-Term Automation Backlog

1. Add `agent-review-pr` output posting to GitHub comments once the prompt format is stable.
2. Add `agent-next` to summarize open PRs, failing checks, stale branches, and suggested next actions.
3. Add task-contract validation in CI for agent-created task files.
4. Add a runner that can execute one approved task contract with a configured local agent command.
5. Add release-gate automation that checks versioning, migrations, deployment notes, and reset plans.

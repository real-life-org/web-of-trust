# How To Work With the Pipeline

Status: operational, non-normative.

This is the practical guide. Read it once, return to it as a reference. The deeper why-and-how lives in `PROJECT-FLOW.md`, `responsibilities.md`, and `local-pipeline.md` — but you do not need them to do your work.

## What's Active Today

| Component | State | Where |
|---|---|---|
| **flow-conformance** GitHub Action | **Live.** Runs on every push to `spec-vnext`/`main`, every PR, plus daily once it lives on `main` | `.github/workflows/flow-conformance.yml` |
| **Pipeline labels** (`agent-task`, `ready`, `blocked`, `paused-by-human`, `pipeline-broken`, etc.) | Live | GitHub Issues / PRs |
| **Pipeline Control issue (#11)** | Live, pinned | The kill switch |
| **Slash commands** (`/flow-gap`, `/flow-task`, `/flow-review`, `/flow-state`) | Available in Claude Code sessions, **manually invoked** | `.claude/commands/` |
| **Review packet generator** (`pnpm agent:review-pr`) | Available, **manually invoked** | `scripts/agent-review-pr.mjs` |
| **CodeRabbit integration** | **Not yet activated.** Template lives at `.coderabbit.example.yaml` | Activation needs a separate human-gated PR |
| **Local cron scripts** for `flow-gap`, `flow-task`, `flow-review`, `flow-state` | **Not yet implemented.** Concept-only in `local-pipeline.md` | — |

In one sentence: every PR and authoritative branch push gets validated automatically; everything else is still manual but follows shared conventions.

## Common Workflows

Each section below answers one question.

### "I want to make a code change"

1. Branch from `spec-vnext` using the pattern `{type}/{short-name}`. The eight valid types are `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `release`, `research`. Example: `git checkout -b refactor/clean-up-imports`.
2. Make the change.
3. Open a PR to `spec-vnext`. Use the body template at `docs/automation/templates/pr-description.md`.
4. **flow-conformance** runs automatically on PR open and every push to the PR branch. If it fails, your PR is red. PR runs do not open `pipeline-broken` issues.
5. Wait for cross-review (currently triggered by Anton — see "How review works").
6. Address findings in follow-up commits. Anton merges when satisfied.

If the change is non-trivial and you want it tracked properly, write a task contract first — see "I want to write a task contract" below.

### "I want to write a task contract" (recommended for any non-trivial change)

A task contract is a YAML file that scopes one slice of work. It is the durable record of what was promised, not a process gate. For small fixes you can skip it; for anything that touches multiple files or could benefit from cross-review, write one.

1. Copy the format from `docs/automation/task-contract.md`. Required fields: `id`, `title`, `repo`, `base`, `type`, `priority`, `goal`, `spec_refs`, `allowed_scope`, `acceptance`, `checks`, `reviewers`, `human_gates`.
2. Save it as `docs/automation/tasks/{id}.yaml` in the same PR as the work. Filename matches the `id`.
3. Reference the contract path in the PR body.

Example contract: `docs/automation/tasks/flow-conformance-watcher.yaml`.

### "How does review work right now?"

Three reviewer agents are available; each has its own focus. None of them currently run automatically — Anton triggers them.

| Reviewer | Role | How invoked today |
|---|---|---|
| **Claude** | `spec`, `architecture`, crypto-`security`, `integration` | Anton starts a Claude Code session and runs `/flow-review <pr>` |
| **Codex** | `tests`, second-pair-of-eyes on the others | Anton runs Codex from his ChatGPT Pro account on the PR |
| **CodeRabbit** | code quality, generic `security` baseline | Will be auto-triggered after activation. Not active yet. |

**Until automation lands**, the rhythm is:

1. PR is opened, flow-conformance runs.
2. Anton (or a human reviewer in scope) runs at least one agent review.
3. Findings come back as PR comments.
4. Author addresses, pushes more commits.
5. When green and reviewed, Anton merges.

You are welcome to run an agent review on a PR you authored — but reviewer agents must not approve their own work. If you (the agent) wrote the code, decline that role and recommend a different one.

### "I found something unclear in the spec"

Don't guess. File a `spec-gap` issue and stop the implementation that triggered it.

1. Open an issue using the template at `docs/automation/templates/issue-spec-gap.md`.
2. Apply label `spec-gap`.
3. Quote the spec text verbatim.
4. List possible resolutions.
5. Anton resolves it in a synchronous spec-authoring session (per Hard Rule 1 in `responsibilities.md`).
6. After resolution, the spec change PR closes the issue, and the original implementation can resume.

For local, non-normative ambiguity (e.g. a UI timeout the spec is silent on), use a `[NEEDS CLARIFICATION: question]` marker in the code — see `clarification-marker.md`.

### "I want to pause everything"

There is one off switch. It is the singleton `Pipeline Control` issue (#11), which is pinned at the top of the issues list.

**To pause:**

```bash
gh issue edit 11 --add-label paused-by-human
```

Or click the label in the GitHub UI. **flow-conformance** sees this within seconds and stops creating/closing/commenting on `pipeline-broken` issues. Future local scripts will respect the same flag. CodeRabbit (when activated) is independent — disable it separately if needed.

**To resume:**

```bash
gh issue edit 11 --remove-label paused-by-human
```

Pause without guilt. The pipeline failing slow is preferable to silent rubber-stamping (see Avoiding Approval Fatigue in `responsibilities.md`).

### "Pipeline is red — what do I do?"

A failed flow-conformance run on an authoritative ref (`spec-vnext` or `main`) opens a per-ref rolling issue with title prefix `flow-conformance: red — {ref}` and label `pipeline-broken`. Failed PR runs only mark the PR red; they do not create or close `pipeline-broken` issues.

1. Open the issue. The body links to the run logs.
2. Read the **Step results** section. It lists which check failed (install / validate / test / build / typecheck).
3. Reproduce locally:
   - **Install failure:** `pnpm install` in this repo, `npm install` in `../wot-spec/`, `pip install -r ../wot-spec/requirements-dev.txt` for the spec validators.
   - **wot-spec validate:** `cd ../wot-spec && npm run validate`.
   - **Core test:** `pnpm --filter @web_of_trust/core test`.
   - **Build/typecheck:** `pnpm --filter @web_of_trust/core build` / `pnpm typecheck`.
4. Fix, push to `spec-vnext`. The next run on green automatically closes the issue.

If the failure is not reproducible locally — e.g. the watcher itself broke — see "Watcher self-failure" below.

### "Watcher self-failure"

If the workflow opens an issue titled `flow-conformance: red — {ref} (watcher self-failure ...)`, validation never finished. This usually means a runner-level issue (action couldn't start, network problem, GitHub-side glitch).

1. Click the run link in the issue body.
2. Look at which step exited unexpectedly.
3. Re-run the workflow manually from the Actions tab if the failure looks transient.
4. If persistent: open a follow-up issue and ping Anton.

### "I want to know the project state"

Until `flow-state` is automated, run it manually in a Claude Code session:

```
/flow-state
```

The command produces a markdown dashboard with conformance status, spec coverage, pipeline activity, drift indicators, and reflection prompts. Save it wherever you want — the typical place is `~/.local/share/flow/state/{date}-state.md`.

For a quicker view: check the GitHub Actions tab for recent flow-conformance runs, and `gh issue list --label pipeline-broken --state open` for active failure issues.

## Per-Role Quick Reference

These roles come from `responsibilities.md`. The pipeline does not enforce them — they describe how the team divides attention.

### As Primary Maintainer (Anton, full-time)

Daily:
- Check `pipeline-broken` issues if any
- Review and merge PRs ready for human gate
- Trigger cross-review on open PRs (`/flow-review` or have Codex run)

Weekly:
- Read the State of Project (Sunday-ish)
- Skim a random open PR in depth (sampling defence against rubber-stamping)
- Triage `spec-gap` issues older than 7 days

When needed:
- Pause via Pipeline Control issue
- Approve task contracts that need it
- Resolve `needs-discussion` PRs where reviewer agents disagree

### As Domain Contributor (phase-based)

Currently no domain is formally "owned". When you take on something:
- Implement features in your scope on a `{type}/{name}` branch
- Cross-review PRs that touch your area when pinged
- File `spec-gap` issues if you hit ambiguity in your domain
- Coordinate scope with Anton before starting larger work

### As Spec Co-Author

A spec co-author is a human formally authorised to edit specific normative `wot-spec/` paths during synchronous sessions (Hard Rule 1). Co-authors review each diff before commit, with AI assistance allowed.

Currently no formal co-authors are listed besides Anton. If a domain-specific co-author is invited later (e.g. for an extension area), the role assignment goes into `responsibilities.md` Current Contributors first.

- Defer to Anton on anything outside the explicitly approved area.

### As Reviewer (anyone wearing that hat for a PR)

- Use the rubric in `pr-review-rubric.md` exactly. Findings come first.
- Reference file:line.
- Identify your reviewer role at the top of the comment.
- Never approve your own work.
- Acknowledge `[NEEDS CLARIFICATION]` markers explicitly.

## Quick Reference: Slash Commands

These work in any Claude Code session in this repo. They live in `.claude/commands/`.

| Command | Purpose | Typical use |
|---|---|---|
| `/flow-gap [--profile <name>]` | Compare conformance manifest against implementation, produce gap report | Weekly, or after spec changes |
| `/flow-task <id\|next>` | Pick or execute a task contract end-to-end (branch, implement, open PR) | When you want autonomous implementation. Most autonomous, use carefully |
| `/flow-review <pr-number\|current> [--role X]` | Structured cross-review of a PR per the rubric | After every non-trivial PR is opened |
| `/flow-state` | Generate the State-of-Project dashboard | Weekly snapshot for the maintainer |

## Quick Reference: Labels

| Label | Meaning |
|---|---|
| `agent-task` | Issue holds or references a task contract |
| `ready` | Task is approved for autonomous execution |
| `needs-cross-review` | PR awaits a second reviewer agent |
| `needs-human` | Requires human decision before proceeding |
| `needs-discussion` | Reviewers disagree, human must decide |
| `ready-for-human` | All reviewers approved, awaiting merge |
| `blocked` | Agent stopped due to a stop condition |
| `paused-by-human` | Pipeline kill switch (only on Issue #11) |
| `spec-gap` | Proposal for normative spec change |
| `gap-analysis` | Weekly gap report |
| `pipeline-broken` | Pipeline script or workflow failure |
| `pipeline-control` | Singleton control issue marker |

## Quick Reference: Key Files

| File | What it tells you |
|---|---|
| `docs/PROJECT-FLOW.md` | The pipeline overview — phases, sources of truth |
| `docs/automation/responsibilities.md` | Who does what, including hard rules and approval policy |
| `docs/automation/task-contract.md` | Format for task contracts |
| `docs/automation/pr-review-rubric.md` | The canonical review output shape |
| `docs/automation/clarification-marker.md` | Convention for `[NEEDS CLARIFICATION]` |
| `docs/automation/local-pipeline.md` | Architecture of local cron-driven phases (mostly future) |
| `docs/automation/coderabbit.md` | How CodeRabbit fits in (when activated) |
| `../wot-spec/research/autonomous-pipeline.md` | The bigger non-normative pipeline vision |

## Troubleshooting

### "I see two `pipeline-broken` issues open"

There is one rolling issue per ref (`spec-vnext` and `main`). Both can be open at the same time if both branches are red. Each closes independently when its own ref returns to green.

### "flow-conformance ran but didn't post an issue when something failed"

First check what triggered the run. `pipeline-broken` issues are only created for authoritative refs (`spec-vnext` or `main`), not for PR events or feature-branch dispatches. If the run was authoritative, check whether `Pipeline Control` (#11) carries the `paused-by-human` label. If it does, validation runs but issue side effects are suppressed. Remove the label to resume.

### "I ran `/flow-task` and it stopped with a `blocked` label"

Read the task contract's stop conditions. Likely causes: scope insufficient, spec ambiguous, conflicts with other work. The agent posts a comment explaining; address the root cause and either expand the contract or split it.

### "A reviewer agent approved its own work"

Reject the review. By rule, an agent that authored a PR may not approve any role on the same PR. Rerun the review with the other agent, or escalate to a human.

### "I do not have access to `wot-spec`"

`wot-spec` is a public repository at `real-life-org/wot-spec`. Clone it next to this repo so they are siblings:

```
~/workspace/
  web-of-trust/   ← this repo
  wot-spec/       ← clone alongside
```

Several slash commands and the local-pipeline scripts assume this layout. The flow-conformance Action does its own checkout and does not need a local clone.

## Asking for Help

- **Pipeline question:** open an issue with no label, ping Anton.
- **Spec question:** open an issue with `spec-gap`.
- **Task you want to take on:** discuss with Anton first if it's larger than a small change. Most work currently flows through Anton's daily attention.
- **Suggestion to improve this guide:** PR welcome.

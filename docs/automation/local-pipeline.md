# Local Pipeline Architecture

Status: operational, non-normative.

The pipeline orchestration runs from local scripts on a maintainer's laptop. GitHub holds all state. The local layer is logic-only and stateless — if a laptop is offline, the pipeline pauses without breaking.

## Principle

> GitHub holds the state. The laptop only holds the logic.

This is the **Externalized State** pattern: the agent's plan, progress, and results live in inspectable, durable files outside the agent's own memory. Restart the laptop, reboot the agent, the workflow continues from whatever GitHub already shows.

State lives in:

- GitHub Issues (the task queue, with labels `agent-task`, `ready`, `blocked`, `paused-by-human`).
- GitHub PRs (work in progress, with labels `needs-cross-review`, `ready-for-human`, `needs-discussion`).
- Repository contents (task contracts in `docs/automation/tasks/`, source code, specs).

The local scripts read state from GitHub via `gh`, run LLM calls via the Claude or Codex CLI, and post results back to GitHub. Restarting from scratch is always safe: the next run reads current GitHub state and continues.

## Local-vs-Remote Split

| Workload | Where | Why |
| --- | --- | --- |
| Conformance tests on every push | GitHub Actions | Must run regardless of laptop state |
| Cross-review trigger | Local | Cheap, no 24/7 need, control rests with maintainer |
| Implementation runs (long LLM calls) | Local | Uses maintainer's Claude Max / Codex Pro quota |
| State-of-Project dashboard | Local | Read once weekly |
| Release builds | GitHub Actions | Reproducibility, no laptop dependency |
| CodeRabbit reviews | GitHub-side third-party | 24/7, independent of any local infrastructure |

The split is pragmatic. Anything that *must* run regardless of the laptop lives in CI or as a third-party app. Anything that benefits from being driven by a maintainer (and uses paid LLM quotas) runs locally.

## Script Layout

Proposed location: `~/.local/bin/flow/`. Each script is small, single-purpose, idempotent, and stateless.

Each script shares the `flow-` prefix to mirror the slash commands in `.claude/commands/`. Slash commands are the interactive entry point for a maintainer; the shell scripts are the cron-driven counterpart that runs the same pipeline phase headless.

| Script | Slash command equivalent | Frequency | Purpose |
| --- | --- | --- | --- |
| `flow-gap.sh` | `/flow-gap` | Weekly (cron, Monday) | Compare conformance manifest against implementation. Generate gap-analysis issue. |
| `flow-task.sh` | `/flow-task` | Hourly (cron) | Take next `agent-task` + `ready` issue. Route to Claude or Codex. Implement. Open PR. |
| `flow-review.sh` | `/flow-review` | Every 15 minutes (cron) | For PRs with `needs-cross-review`, trigger the other agent's review. |
| `flow-state.sh` | `/flow-state` | Weekly (cron, Sunday evening) | Generate the architecture dashboard for human review. |
| `flow-pause-check.sh` | — | Pre-hook in every script above | Exit if the Pipeline Control issue carries `paused-by-human`. |

**Note: conformance lives in CI, not on the laptop.** The conformance watcher is implemented as a GitHub Actions workflow (`.github/workflows/flow-conformance.yml`) instead of a local cron script. This phase has no LLM cost, runs read-only, and must execute regardless of whether any maintainer's laptop is online — exactly the criteria from the Local-vs-Remote Split table above. The other pipeline phases stay local because they consume the maintainer's Claude Max / Codex Pro subscription quotas.

## Process Manager

Use `systemd --user` instead of bare cron for the local scripts (`flow-gap`, `flow-task`, `flow-review`, `flow-state`):

- Logs go to journald — for example `journalctl --user -u flow-state`.
- Failed services restart automatically with backoff.
- Status is queryable: `systemctl --user status flow-pipeline.target`.
- Defining a target lets the maintainer enable or disable the whole local pipeline atomically.

(Note: `flow-conformance` is the one phase that does not run via systemd — it lives in `.github/workflows/flow-conformance.yml` on the GitHub side. Logs and status for that phase are visible in the Actions tab on GitHub, not via `journalctl`.)

## Concurrency and Limits

- **Locking.** Every long-running script wraps its body in `flock` against `/run/user/$UID/flow-{name}.lock` so the next cron tick does not start a parallel run.
- **Daily caps.** Hard limits on tasks-per-day (e.g. 10) and tokens-per-day (per agent). Defaults conservative until trust is established.
- **Failure budget.** If a script fails N times in a row, it stops itself and posts a `pipeline-broken` issue rather than retrying silently.

## Logs and Observability

- Each script writes to `~/.local/share/flow/logs/{script}-{date}.log`.
- A daily rollup script summarises yesterday's pipeline activity into a Markdown file used by the State-of-Project dashboard.
- Failures post a GitHub issue with label `pipeline-broken` so failures stay visible even if the maintainer doesn't read local logs.

## Bootstrapping Order

Conservative to bold. Each step is independently useful and reversible.

1. **Conformance watcher** (GitHub Action — `.github/workflows/flow-conformance.yml`). Daily schedule + on push, posts only on regression as a single rolling issue. Zero risk, immediate value, no laptop dependency.
2. **State-of-Project dashboard** (local). Weekly cron, generates the Sunday read.
3. **Cross-review triggers** (local). 15-minute cron, runs Claude review on PRs with `needs-cross-review`.
4. **Gap analysis** (local). Weekly cron, generates task suggestions as issues.
5. **Implementation runner** (local). Hourly cron, picks `ready` tasks. Most autonomous step — enabled last, only after the observation and review layers are stable and trusted.

The order is intentional: build the observation and review surface first, then trust enough to delegate implementation. Reversing the order risks producing PRs faster than humans can verify them.

## Kill Switch

GitHub does not support repository-level labels — labels attach to issues and PRs. The kill switch therefore uses a **singleton control issue** as the global pause flag.

### Setup (one-time)

Open one issue in the repository with the exact title `Pipeline Control` and pin it. This issue is not closed; it stays open as the durable control surface.

```bash
gh issue create \
  --title "Pipeline Control" \
  --body "Singleton issue used as the pipeline kill switch. Add the label \`paused-by-human\` to pause all local automation. Remove the label to resume." \
  --label "pipeline-control"
gh issue pin <issue-number>
```

Create the `paused-by-human` label as well (one-time):

```bash
gh label create paused-by-human --color B60205 --description "Pause all local pipeline automation"
```

### Pause and resume

- **Pause:** Add the label `paused-by-human` to the `Pipeline Control` issue (GitHub UI: one click, or `gh issue edit <n> --add-label paused-by-human`).
- **Resume:** Remove the label.

### How scripts check it

Every cron-driven script begins with a pause check that matches the title exactly. A substring search would also match issues like `Pipeline Control follow-up` or `Pipeline Control retro` and silently treat them as the pause flag, so use exact-title filtering:

```bash
PAUSED=$(gh issue list \
  --label paused-by-human \
  --state open \
  --json number,title \
  --jq '.[] | select(.title == "Pipeline Control") | .number')
[[ -n "$PAUSED" ]] && exit 0
```

If the exact-title match returns the singleton control issue with the pause label, the script exits cleanly. CodeRabbit continues running independently — to also pause its reviews, remove `.coderabbit.yaml` (see `docs/automation/coderabbit.md`).

### Why this design

- **Singleton.** Exactly one control issue means there is no ambiguity about *which* labelled issue counts.
- **Cheap.** Setting the label is one click. Resume is one click.
- **Visible.** The pinned issue makes the pipeline state obvious to anyone visiting the repo.
- **Auditable.** Label history shows when pauses happened and why (issue comments).

This is the maintainer's emergency brake. Use it whenever the pipeline produces output that needs human review before continuing — ambiguous spec interpretation, unexpected regressions, or simply when the maintainer wants quiet time to think.

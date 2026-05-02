# Local Pipeline Architecture

Status: operational, non-normative.

The pipeline orchestration runs from local scripts on a maintainer's laptop. GitHub holds all state. The local layer is logic-only and stateless — if a laptop is offline, the pipeline pauses without breaking.

## Principle

> GitHub holds the state. The laptop only holds the logic.

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

Proposed location: `~/.local/bin/wot-pipeline/`. Each script is small, single-purpose, idempotent, and stateless.

| Script | Frequency | Purpose |
| --- | --- | --- |
| `conformance-watch.sh` | Daily (cron) | Run `npm run validate` in `wot-spec` and `pnpm test` in `web-of-trust`. Open issue on regression only. |
| `gap-analyze.sh` | Weekly (cron, Monday) | Compare conformance manifest against implementation. Generate gap-analysis issue. |
| `pick-and-implement.sh` | Hourly (cron) | Take next `agent-task` + `ready` issue. Route to Claude or Codex. Implement. Open PR. |
| `cross-review.sh` | Every 15 minutes (cron) | For PRs with `needs-cross-review`, trigger the other agent's review. |
| `state-of-project.sh` | Weekly (cron, Sunday evening) | Generate the architecture dashboard for human review. |
| `pause-check.sh` | Pre-hook in every script above | Exit if `paused-by-human` label is set on the repo. |

## Process Manager

Use `systemd --user` instead of bare cron:

- Logs go to journald — `journalctl --user -u wot-conformance-watch`.
- Failed services restart automatically with backoff.
- Status is queryable: `systemctl --user status wot-pipeline.target`.
- Defining a target lets the maintainer enable or disable the whole pipeline atomically.

## Concurrency and Limits

- **Locking.** Every long-running script wraps its body in `flock` against `/run/user/$UID/wot-pipeline-{name}.lock` so the next cron tick does not start a parallel run.
- **Daily caps.** Hard limits on tasks-per-day (e.g. 10) and tokens-per-day (per agent). Defaults conservative until trust is established.
- **Failure budget.** If a script fails N times in a row, it stops itself and posts a `pipeline-broken` issue rather than retrying silently.

## Logs and Observability

- Each script writes to `~/.local/share/wot-pipeline/logs/{script}-{date}.log`.
- A daily rollup script summarises yesterday's pipeline activity into a Markdown file used by the State-of-Project dashboard.
- Failures post a GitHub issue with label `pipeline-broken` so failures stay visible even if the maintainer doesn't read local logs.

## Bootstrapping Order

Conservative to bold. Each step is independently useful and reversible.

1. **Conformance watcher.** Daily cron, posts only on regression. Zero risk, immediate value.
2. **State-of-Project dashboard.** Weekly cron, generates the Sunday read.
3. **Cross-review triggers.** 15-minute cron, runs Claude review on PRs with `needs-cross-review`.
4. **Gap analysis.** Weekly cron, generates task suggestions as issues.
5. **Implementation runner.** Hourly cron, picks `ready` tasks. Most autonomous step — enabled last, only after the observation and review layers are stable and trusted.

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

Every cron-driven script begins with a pause check:

```bash
PAUSED=$(gh issue list \
  --search 'in:title "Pipeline Control"' \
  --label paused-by-human \
  --state open \
  --json number)
[[ "$PAUSED" != "[]" ]] && exit 0
```

If the search returns the control issue with the pause label, the script exits cleanly. CodeRabbit continues running independently — to also pause its reviews, remove `.coderabbit.yaml` (see `docs/automation/coderabbit.md`).

### Why this design

- **Singleton.** Exactly one control issue means there is no ambiguity about *which* labelled issue counts.
- **Cheap.** Setting the label is one click. Resume is one click.
- **Visible.** The pinned issue makes the pipeline state obvious to anyone visiting the repo.
- **Auditable.** Label history shows when pauses happened and why (issue comments).

This is the maintainer's emergency brake. Use it whenever the pipeline produces output that needs human review before continuing — ambiguous spec interpretation, unexpected regressions, or simply when the maintainer wants quiet time to think.

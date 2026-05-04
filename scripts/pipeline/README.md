# Pipeline Scripts

Status: operational, non-normative.

This directory holds the local cron-driven pipeline scripts described in `docs/automation/local-pipeline.md`. They are the laptop-side counterpart to the slash commands in `.claude/commands/` and to GitHub-side actions like `.github/workflows/flow-conformance.yml`.

## Currently shipped

| Script | Purpose | Status |
| --- | --- | --- |
| `flow-review.sh` | Triggers Claude cross-reviews on open PRs missing one. Iteration 1: Claude only. | Implemented |

Other phases (`flow-state`, `flow-gap`, `flow-task`, Codex side of `flow-review`) are still concept-only in `docs/automation/local-pipeline.md`.

## Install: flow-review

This walks the maintainer through enabling `flow-review.sh` on their own laptop. Other team members do not run this — pipeline scripts execute against the maintainer's personal Claude / GitHub credentials.

### 1. Prerequisites

```bash
# claude CLI installed and logged in
claude --version
claude /login          # if you have not authenticated yet

# gh CLI installed and logged in
gh --version
gh auth status         # should show "Logged in to github.com"

# pnpm available (for the agent:review-pr packet generator)
pnpm --version

# systemd-user enabled (so the timer survives logout)
loginctl show-user "$USER" -p Linger
# If "Linger=no", enable it:
sudo loginctl enable-linger "$USER"
```

### 2. Create the GitHub label (one-time)

```bash
gh label create reviewed-by-claude \
  --color 5319E7 \
  --description "Claude has produced a cross-review on this PR" \
  --repo real-life-org/web-of-trust
```

### 3. Install the systemd units

```bash
mkdir -p ~/.config/systemd/user

# Copy (do not symlink — systemd parses the file directly and resolves %h)
cp scripts/pipeline/systemd/flow-review.service ~/.config/systemd/user/
cp scripts/pipeline/systemd/flow-review.timer   ~/.config/systemd/user/

systemctl --user daemon-reload
```

### 4. Verify the WorkingDirectory

The service file assumes the repo lives at `~/workspace/workspace/web-of-trust`. If your checkout is elsewhere, edit the `WorkingDirectory=` and `ExecStart=` lines in the copied service file (do this in `~/.config/systemd/user/flow-review.service`, not in the repo).

You can also override at runtime by editing the script's defaults at the top of `flow-review.sh`, but the cleanest path is to keep the repo at the documented location.

### 5. Dry-run first

Always test the script manually once before enabling the timer:

```bash
cd ~/workspace/workspace/web-of-trust
./scripts/pipeline/flow-review.sh
```

Watch the output. The first run will:

- Check `gh` and `claude` are authenticated.
- Check the Pipeline Control issue.
- List candidate PRs (those without `reviewed-by-claude`, not draft, not paused, not Claude-authored).
- For each, generate a packet, run claude headless, post the review, label the PR.

If anything fails, the script writes to `~/.local/share/flow/logs/flow-review-{date}.log` and (for setup-level failures) opens a `pipeline-broken` issue.

### 6. Enable the timer

```bash
systemctl --user enable --now flow-review.timer

# Verify
systemctl --user list-timers flow-review.timer
systemctl --user status flow-review.service
```

The timer fires every 15 minutes after the last completion, plus catches up any missed runs after the laptop boots.

### 7. Logs

```bash
# Recent journal entries
journalctl --user -u flow-review.service -n 50

# Or the per-day log file
tail -f ~/.local/share/flow/logs/flow-review-$(date -u +%Y-%m-%d).log
```

## Configuration

`flow-review.sh` reads these environment variables (all optional):

| Variable | Default | Purpose |
| --- | --- | --- |
| `FLOW_REVIEW_REPO` | `real-life-org/web-of-trust` | Target repository for `gh` calls |
| `FLOW_REVIEW_REPO_ROOT` | `$HOME/workspace/workspace/web-of-trust` | Local repo path used for `pnpm agent:review-pr` and the slash-command file |
| `FLOW_REVIEW_DAILY_CAP` | `30` | Maximum reviews per UTC day (quota safety net) |
| `FLOW_REVIEW_PER_TICK_CAP` | `5` | Maximum PRs handled per 15-minute tick |
| `FLOW_REVIEW_STATE_DIR` | `$HOME/.local/share/flow` | Where the per-day counter and logs live |

Override in the systemd service file via `Environment=` lines if needed.

## Disable / pause

To pause **just this script** without disabling the timer: nothing — the script honours the singleton Pipeline Control issue, so add the `paused-by-human` label to issue #11 and the script exits cleanly on the next tick.

To disable the timer entirely:

```bash
systemctl --user disable --now flow-review.timer
```

To uninstall:

```bash
systemctl --user disable --now flow-review.timer
rm ~/.config/systemd/user/flow-review.{service,timer}
systemctl --user daemon-reload
```

## What this script is NOT

- Not a code-changer. It only posts review comments and adds labels.
- Not a merger. Merge stays with the maintainer.
- Not a synthesis layer. It does not set `ready-for-human` or `needs-discussion` — that synthesis is a follow-up task contract, after this iteration is proven stable.
- Not a Codex driver. Codex automation needs separate work because ChatGPT Pro CLI auth is not designed for headless cron use.

## Troubleshooting

See `docs/automation/HOW-TO.md` "Troubleshooting" section. Specific to `flow-review.sh`:

- **No reviews appear after 15 minutes**: check `systemctl --user status flow-review.timer` (timer enabled?), then look at logs.
- **Review posted but in the wrong format**: claude output did not match the rubric. Look at the per-day log; the script prefixes a warning comment in that case so you can see the raw output on the PR.
- **Daily cap reached too quickly**: someone opened a lot of PRs. Set `FLOW_REVIEW_DAILY_CAP` higher in the service file, or just let it resume tomorrow.
- **Self-failure issue keeps getting comments**: the timer keeps firing every 15 minutes, but the script rate-limits same-reason self-failure messages to **once per UTC day**. The issue stays open as a signal; only the comment volume is capped. Fix the precondition; the next tick that gets past pre-flight will automatically close the issue.
- **Self-failure issue stays open even after I fixed the cause**: the script only closes self-failure issues when a tick reaches the main loop successfully. If your fix happens during a paused window, it will close on the first non-paused tick after that. To force-close, just close the issue manually — the script will not re-open one until a new failure occurs.

#!/usr/bin/env bash
#
# flow-review.sh — Phase 2 of the project-flow pipeline.
#
# Triggers Claude cross-reviews on open PRs that are missing one.
# Designed to run from systemd-user timer every 15 minutes with
# Persistent=true. Stateless — all state lives on GitHub (labels) and
# in two small per-day files for rate-limiting.
#
# Read docs/PROJECT-FLOW.md, docs/automation/responsibilities.md, and
# docs/automation/local-pipeline.md for the bigger picture.
#
# Iteration 1: Claude reviewer only. Codex stays manual.

set -euo pipefail

# ─── Configuration ─────────────────────────────────────────────────────

REPO="${FLOW_REVIEW_REPO:-real-life-org/web-of-trust}"
DAILY_CAP="${FLOW_REVIEW_DAILY_CAP:-30}"
PER_TICK_CAP="${FLOW_REVIEW_PER_TICK_CAP:-5}"
STATE_DIR="${FLOW_REVIEW_STATE_DIR:-$HOME/.local/share/flow}"
LOGS_DIR="${STATE_DIR}/logs"
COUNTER_FILE="${STATE_DIR}/state/flow-review-counter-$(date -u +%Y-%m-%d)"
TODAY="$(date -u +%Y-%m-%d)"
LOG_FILE="${LOGS_DIR}/flow-review-${TODAY}.log"

# Path to repo (where .claude/commands/flow-review.md lives and where
# we run pnpm agent:review-pr from). Configurable so the script can be
# moved or symlinked out of the repo.
REPO_ROOT="${FLOW_REVIEW_REPO_ROOT:-$HOME/workspace/workspace/web-of-trust}"

# ─── Bootstrap ─────────────────────────────────────────────────────────

mkdir -p "${LOGS_DIR}" "${STATE_DIR}/state"

log() {
  printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "${LOG_FILE}" >&2
}

die() {
  log "FATAL: $*"
  exit 1
}

# ─── Self-failure issue management ─────────────────────────────────────
#
# When the script itself cannot run (claude CLI missing, repo missing,
# gh not authenticated), surface that as a single rolling pipeline-broken
# issue rather than failing silently. Mirrors the watcher self-failure
# pattern from flow-conformance.

# Path used to suppress duplicate "still broken" comments within one
# UTC day. We open the issue at most once and then re-comment at most
# once per day per reason — the systemd timer keeps firing every 15
# minutes, so without a cap the issue would flood with identical
# messages.
SELF_FAILURE_MARKER_DIR="${STATE_DIR}/state/self-failure"

post_self_failure() {
  local reason="$1"
  log "Self-failure detected: ${reason}"

  mkdir -p "${SELF_FAILURE_MARKER_DIR}"
  local marker_key
  marker_key="$(echo "${reason}" | tr -c 'a-zA-Z0-9' '_' | head -c 64)"
  local marker_file="${SELF_FAILURE_MARKER_DIR}/${marker_key}-${TODAY}"

  local existing
  existing=$(gh issue list \
    --repo "${REPO}" \
    --label pipeline-broken \
    --state open \
    --json number,title \
    --jq '.[] | select(.title | startswith("flow-review: self-failure")) | .number' \
    2>/dev/null | head -1 || true)

  # If we have already commented on this reason today, do nothing.
  # The issue stays open as a visible signal; we just stop spamming.
  if [[ -n "${existing}" && -f "${marker_file}" ]]; then
    log "Already reported '${reason}' on issue #${existing} today. Suppressing."
    return 0
  fi

  local body
  body=$(cat <<MSG
## flow-review script self-failure

The local cron script could not run.

Reason: \`${reason}\`
Host: $(hostname 2>/dev/null || echo unknown)
Time: $(date -u +%Y-%m-%dT%H:%M:%SZ)
Log: \`${LOG_FILE}\`

The systemd timer will keep firing every 15 minutes, but this issue body and any same-reason comments are rate-limited to once per UTC day. Once the underlying cause is fixed, the next successful tick will close this issue automatically. To stop sooner, close the issue or add the \`paused-by-human\` label to the Pipeline Control issue.
MSG
  )

  if [[ -n "${existing}" ]]; then
    gh issue comment "${existing}" --repo "${REPO}" --body "${body}" >/dev/null 2>&1 || true
  else
    gh issue create \
      --repo "${REPO}" \
      --title "flow-review: self-failure ($(date -u +%Y-%m-%d))" \
      --label pipeline-broken \
      --body "${body}" >/dev/null 2>&1 || true
  fi

  touch "${marker_file}"
}

# Close any open self-failure issue when a tick gets past pre-flight
# without dying. Called from the success path at the bottom of the
# script. Idempotent: no-op if no issue is open.
close_self_failure_issues() {
  local existing
  existing=$(gh issue list \
    --repo "${REPO}" \
    --label pipeline-broken \
    --state open \
    --json number,title \
    --jq '.[] | select(.title | startswith("flow-review: self-failure")) | .number' \
    2>/dev/null || true)

  if [[ -z "${existing}" ]]; then
    return 0
  fi

  while IFS= read -r issue_num; do
    [[ -z "${issue_num}" ]] && continue
    log "Closing recovered self-failure issue #${issue_num}"
    gh issue comment "${issue_num}" --repo "${REPO}" \
      --body "flow-review reached the main loop successfully on $(date -u +%Y-%m-%dT%H:%M:%SZ). Closing." \
      >/dev/null 2>&1 || true
    gh issue close "${issue_num}" --repo "${REPO}" --reason completed >/dev/null 2>&1 || true
  done <<< "${existing}"

  # Clear today's marker files so a future failure can post fresh.
  rm -f "${SELF_FAILURE_MARKER_DIR}/"*"-${TODAY}" 2>/dev/null || true
}

# ─── Pre-flight checks ─────────────────────────────────────────────────

if ! command -v gh >/dev/null 2>&1; then
  # gh check happens before post_self_failure can run, so fail loudly.
  die "gh CLI not on PATH"
fi

if ! gh auth status >/dev/null 2>&1; then
  post_self_failure "gh CLI is not authenticated"
  die "gh CLI not authenticated"
fi

if ! command -v claude >/dev/null 2>&1; then
  post_self_failure "claude CLI not on PATH"
  die "claude CLI not on PATH"
fi

if ! command -v jq >/dev/null 2>&1; then
  post_self_failure "jq not on PATH"
  die "jq not on PATH"
fi

if ! command -v pnpm >/dev/null 2>&1; then
  post_self_failure "pnpm not on PATH"
  die "pnpm not on PATH"
fi

if [[ ! -d "${REPO_ROOT}" ]]; then
  post_self_failure "Repository root not found at ${REPO_ROOT}"
  die "Repo root missing: ${REPO_ROOT}"
fi

if [[ ! -f "${REPO_ROOT}/.claude/commands/flow-review.md" ]]; then
  post_self_failure "Slash command file missing at ${REPO_ROOT}/.claude/commands/flow-review.md"
  die "Slash command file missing"
fi

# ─── Pause-by-human check ──────────────────────────────────────────────
#
# Singleton Pipeline Control issue with paused-by-human label means
# the maintainer wants quiet. Honour it.

PAUSED=$(gh issue list \
  --repo "${REPO}" \
  --label paused-by-human \
  --state open \
  --json number,title \
  --jq '.[] | select(.title == "Pipeline Control") | .number' \
  2>/dev/null || true)

if [[ -n "${PAUSED}" ]]; then
  log "Paused by human (Pipeline Control issue #${PAUSED}). Exiting."
  exit 0
fi

# ─── Recovery: close any open self-failure issue ───────────────────────
#
# We got past every pre-flight check and the pause check. If a previous
# tick had opened a "flow-review: self-failure" issue, the underlying
# cause is now resolved — close it so the maintainer's pipeline-broken
# inbox does not stay red forever.

close_self_failure_issues

# ─── Daily cap ─────────────────────────────────────────────────────────

CURRENT_COUNT=0
if [[ -f "${COUNTER_FILE}" ]]; then
  CURRENT_COUNT=$(cat "${COUNTER_FILE}")
fi

if (( CURRENT_COUNT >= DAILY_CAP )); then
  log "Daily cap reached (${CURRENT_COUNT}/${DAILY_CAP}). Exiting."
  exit 0
fi

log "Tick start. Today's review count: ${CURRENT_COUNT}/${DAILY_CAP}."

# ─── Find PRs needing Claude review ────────────────────────────────────
#
# Criteria:
#   - state: OPEN
#   - not draft
#   - does not already carry reviewed-by-claude
#   - does not carry paused-by-human (PR-level pause)

CANDIDATES=$(gh pr list \
  --repo "${REPO}" \
  --state open \
  --json number,headRefName,author,isDraft,labels,commits \
  --jq '
    [.[] |
      select(.isDraft == false) |
      select((.labels // []) | map(.name) | contains(["reviewed-by-claude"]) | not) |
      select((.labels // []) | map(.name) | contains(["paused-by-human"]) | not) |
      {
        number,
        head: .headRefName,
        author: .author.login,
        coAuthors: ([.commits[].messageBody // ""] | join("\n"))
      }
    ]
  ' 2>/dev/null || echo '[]')

CANDIDATE_COUNT=$(echo "${CANDIDATES}" | jq 'length')
log "Found ${CANDIDATE_COUNT} candidate PR(s) needing Claude review."

if (( CANDIDATE_COUNT == 0 )); then
  log "Nothing to do. Exiting."
  exit 0
fi

# ─── Per-PR processing ─────────────────────────────────────────────────

PROCESSED=0
SKIPPED_SELF=0
FAILED=0

while IFS= read -r row; do
  if (( PROCESSED >= PER_TICK_CAP )); then
    log "Per-tick cap reached (${PER_TICK_CAP}). Remaining PRs deferred to next tick."
    break
  fi
  if (( CURRENT_COUNT + PROCESSED >= DAILY_CAP )); then
    log "Daily cap will be reached. Stopping this tick."
    break
  fi

  PR_NUMBER=$(echo "${row}" | jq -r '.number')
  PR_HEAD=$(echo "${row}" | jq -r '.head')
  PR_AUTHOR=$(echo "${row}" | jq -r '.author')
  PR_COAUTHORS=$(echo "${row}" | jq -r '.coAuthors')

  # ── Self-review check ────────────────────────────────────────────────
  # Claude must not review its own work. Detect via Co-Authored-By
  # trailer in any commit message.
  if echo "${PR_COAUTHORS}" | grep -qiE 'Co-Authored-By:\s*Claude'; then
    log "PR #${PR_NUMBER}: Claude is a co-author — skipping (self-review prohibition)."
    SKIPPED_SELF=$((SKIPPED_SELF + 1))
    continue
  fi

  log "PR #${PR_NUMBER} (${PR_HEAD} by ${PR_AUTHOR}): generating review packet."

  # ── Generate packet via existing script ──────────────────────────────
  PACKET_FILE="$(mktemp -t flow-review-pr-${PR_NUMBER}-XXXXXX.md)"
  if ! (cd "${REPO_ROOT}" && pnpm agent:review-pr "${PR_NUMBER}" \
          --max-diff-chars 60000 --write "${PACKET_FILE}") >/dev/null 2>&1; then
    log "PR #${PR_NUMBER}: agent:review-pr failed. Skipping this PR."
    rm -f "${PACKET_FILE}"
    FAILED=$((FAILED + 1))
    continue
  fi

  # ── Build the prompt ─────────────────────────────────────────────────
  # Take the slash-command file, substitute $ARGUMENTS with the PR
  # number, and append the generated packet so Claude has everything
  # in one prompt.

  COMMAND_BODY=$(awk '
    /^---$/ { delim++; next }
    delim >= 2 { print }
  ' "${REPO_ROOT}/.claude/commands/flow-review.md")

  PROMPT_FILE="$(mktemp -t flow-review-prompt-${PR_NUMBER}-XXXXXX.md)"
  {
    echo "${COMMAND_BODY//\$ARGUMENTS/${PR_NUMBER}}"
    echo ""
    echo "---"
    echo ""
    echo "## Pre-generated review packet"
    echo ""
    echo "The packet below was generated for you by \`pnpm agent:review-pr ${PR_NUMBER}\`. Use it as the source of truth for PR contents. Do NOT regenerate it."
    echo ""
    cat "${PACKET_FILE}"
    echo ""
    echo "---"
    echo ""
    echo "## Output instruction"
    echo ""
    echo "Output ONLY the review markdown — one or more \`## Cross-Review: {Role}\` blocks following \`docs/automation/pr-review-rubric.md\`. Do not narrate, do not ask the human anything, do not call gh or other tools. The cron driver will post your output verbatim as a PR comment."
  } > "${PROMPT_FILE}"

  # ── Run Claude headless ──────────────────────────────────────────────
  REVIEW_FILE="$(mktemp -t flow-review-output-${PR_NUMBER}-XXXXXX.md)"

  # Restrict claude to truly read-only tools. The pre-generated packet
  # and the prompt body contain everything claude needs; no shell or
  # write tools should be reachable from an unattended cron run.
  log "PR #${PR_NUMBER}: invoking claude (headless, Read tool only)."
  if ! claude -p "$(cat "${PROMPT_FILE}")" \
        --allowedTools "Read" \
        > "${REVIEW_FILE}" 2>>"${LOG_FILE}"; then
    log "PR #${PR_NUMBER}: claude invocation failed. Skipping."
    rm -f "${PACKET_FILE}" "${PROMPT_FILE}" "${REVIEW_FILE}"
    FAILED=$((FAILED + 1))
    continue
  fi

  # ── Sanity-check the output ──────────────────────────────────────────
  if ! grep -q '^## Cross-Review:' "${REVIEW_FILE}"; then
    log "PR #${PR_NUMBER}: claude output missing expected header. Posting anyway with warning prefix."
    {
      echo "<!-- flow-review: claude output did not match the expected rubric format. Posting raw output for inspection. -->"
      echo ""
      cat "${REVIEW_FILE}"
    } > "${REVIEW_FILE}.wrapped"
    mv "${REVIEW_FILE}.wrapped" "${REVIEW_FILE}"
  fi

  # ── Add attribution footer ──────────────────────────────────────────
  cat >> "${REVIEW_FILE}" <<MSG

---

*Posted automatically by \`scripts/pipeline/flow-review.sh\` on $(date -u +%Y-%m-%dT%H:%M:%SZ).*
MSG

  # ── Post the review ──────────────────────────────────────────────────
  if ! gh pr review "${PR_NUMBER}" \
        --repo "${REPO}" \
        --comment \
        --body-file "${REVIEW_FILE}" >/dev/null 2>&1; then
    log "PR #${PR_NUMBER}: gh pr review failed. Skipping label step."
    rm -f "${PACKET_FILE}" "${PROMPT_FILE}" "${REVIEW_FILE}"
    FAILED=$((FAILED + 1))
    continue
  fi

  # ── Mark PR as reviewed by Claude ────────────────────────────────────
  if ! gh pr edit "${PR_NUMBER}" \
        --repo "${REPO}" \
        --add-label reviewed-by-claude >/dev/null 2>&1; then
    log "PR #${PR_NUMBER}: failed to add reviewed-by-claude label (review still posted)."
  fi

  # ── Cleanup + bookkeeping ────────────────────────────────────────────
  rm -f "${PACKET_FILE}" "${PROMPT_FILE}" "${REVIEW_FILE}"
  PROCESSED=$((PROCESSED + 1))
  log "PR #${PR_NUMBER}: review posted."

done < <(echo "${CANDIDATES}" | jq -c '.[]')

# ─── Persist counter ───────────────────────────────────────────────────

NEW_COUNT=$((CURRENT_COUNT + PROCESSED))
echo "${NEW_COUNT}" > "${COUNTER_FILE}"

log "Tick done. Processed: ${PROCESSED}, skipped (self): ${SKIPPED_SELF}, failed: ${FAILED}. Today's count: ${NEW_COUNT}/${DAILY_CAP}."

exit 0

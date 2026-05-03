---
description: Pick or execute an agent task contract autonomously, opening a branch and PR
argument-hint: "<task-id|next>"
---

You are running phase 3 of the project-flow pipeline (`docs/PROJECT-FLOW.md`). Your job is to execute one task contract end-to-end: branch, implement, verify, open PR.

## Input

- $ARGUMENTS contains either a specific task id (e.g. `pipeline-roles-and-followups`) or the literal `next` to pick the next ready task.
- Task contracts live as YAML in `docs/automation/tasks/{id}.yaml`.
- The contract format is defined in `docs/automation/task-contract.md` and validated against `docs/automation/task-contract.schema.json`.

## Pre-flight

1. **Pause check.** Run:

   ```bash
   gh issue list --search 'in:title "Pipeline Control"' --label paused-by-human --state open --json number
   ```

   If the result is non-empty, exit immediately with the message "Pipeline paused by human."

2. **Pick task.**
   - If $ARGUMENTS is a specific id: load `docs/automation/tasks/{id}.yaml`.
   - If $ARGUMENTS is `next`: list `gh issue list --label "agent-task,ready" --json number,body --limit 1` and resolve to the YAML referenced by the issue.

3. **Validate the contract.** Parse the YAML, check it matches `task-contract.schema.json`. If invalid, stop and report.

4. **Check human gates.** If the contract lists any human gate that applies here (e.g. "Public API breaking change" and the task involves package exports), stop and ask the human to approve before proceeding.

## Execution

1. **Branch.** Create `agent/claude/{task-id}` from the contract's `base` branch.
2. **Implement.** Stay strictly within `allowed_scope`. Never touch `forbidden_scope`. If you find you need to touch something outside scope, stop and ask — that is a stop condition per the contract spec.
3. **Use clarification markers.** When you encounter ambiguity that the task contract or spec does not resolve, add `[NEEDS CLARIFICATION: question]` per `docs/automation/clarification-marker.md`. Do not guess silently.
4. **Run checks.** Execute every command in the contract's `checks` list. Capture results.

## Open PR

After successful implementation:

1. Commit with a Conventional-Commit style message that references the task id.
2. Push the branch.
3. Open a PR with `gh pr create`. Use the template in `docs/automation/templates/pr-description.md`. Include:
   - Reference to the task contract path.
   - Verification: which checks ran and their result.
   - Clarifications: every `[NEEDS CLARIFICATION]` marker added.
   - Residual risk.
4. Add label `needs-cross-review` to the PR.
5. Comment on the source issue (if any) with `Closes #N`.

## Stop Conditions

Stop and report instead of completing if any of these happen (per `task-contract.md`):

- A human gate triggers.
- Required checks cannot run locally.
- Allowed scope is insufficient.
- The task conflicts with unrelated worktree changes.
- The spec reference is ambiguous or contradictory and you cannot resolve it with a clarification marker.
- The implementation would require a larger architectural decision than the contract allows.

When stopping, comment on the source issue (or task contract if no issue exists yet) explaining why, and add label `blocked`.

## Rules

- One task = one branch = one PR. Do not merge other work into the branch.
- Never edit normative `wot-spec/` paths from this command. That is reserved for synchronous spec-authoring per Hard Rule 1.
- Do not merge your own PR. Ever.

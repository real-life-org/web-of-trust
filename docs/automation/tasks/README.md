# Agent Task Contracts

Status: operational, non-normative.

This directory holds the YAML task contracts described in `docs/automation/task-contract.md`. Each file represents one slice of work an agent may execute.

## Storage Model

- Each task contract is a YAML file in this directory: `tasks/{id}.yaml`.
- The `id` field matches the filename without extension and follows the kebab-case rule from `task-contract.schema.json`.
- One contract = one branch = one PR. The PR description should reference the contract path.
- Validation: `task-contract.schema.json` is the canonical schema. CI will validate every YAML in this directory once `agent-task-validate` (backlog item 3 in `PROJECT-FLOW.md`) lands.

## Lifecycle

1. **Created** — by a planner agent or human, committed to `main` or merged via a planning PR.
2. **Ready** — a corresponding GitHub Issue with label `agent-task` + `ready` is opened, linking to the YAML file.
3. **In progress** — implementer agent picks the issue, opens a branch named after the contract `id`.
4. **Done** — PR merges, issue closes, contract YAML stays in repo as historical record.

## Why YAML in repo, not just GitHub Issues?

- **Versioned**: contracts are diffable, reviewable like code.
- **Structured**: schema-validated, not free-form Markdown.
- **Reproducible**: an agent can re-run the same contract verbatim.
- **Discoverable**: future contributors see what work was contracted, not only what shipped.

GitHub Issues remain the queue and conversation surface. The YAML file is the durable contract.

# Issue Template: Agent Task

Used when filing a GitHub Issue that points to a task contract in `docs/automation/tasks/`. Apply labels `agent-task` and `ready` (or `needs-human` if a human gate is unresolved).

```markdown
## Task: {short title}

**Contract:** [`docs/automation/tasks/{id}.yaml`](docs/automation/tasks/{id}.yaml)
**Priority:** {low | medium | high | critical}
**Type:** {feat | fix | refactor | docs | test | chore | release | research}

## Why

{One paragraph: what problem does this solve, what spec gap or roadmap milestone does it advance.}

## Acceptance (mirrored from contract)

- [ ] {Acceptance criterion 1}
- [ ] {Acceptance criterion 2}
- [ ] All `checks` in the contract pass.

## Human Gates (mirrored from contract)

- {Gate name} — must trigger if encountered.
- Or `None`.

## Notes

{Anything not covered by the contract that an implementer should know. Keep this short. If it's substantial, it belongs in the contract `notes` field instead.}
```

## Rules

- The issue body is a thin wrapper around the contract, not a substitute for it. The contract is canonical.
- Acceptance and human gates are duplicated for visibility — they must match the YAML exactly.
- Do not embed implementation details in the issue. Implementer reads the contract for those.

# Automation Templates

Status: operational, non-normative.

This directory holds the templates that produce reproducible, comparable artifacts across the pipeline. Reproducibility matters because the integrator role and the human reviewer scan many issues, PRs, and reviews — consistent shape lets them compare quickly.

## Templates

| Template | Used by | When |
| --- | --- | --- |
| `issue-agent-task.md` | Planner agent / human | When filing a GitHub Issue that points to a task contract. |
| `issue-spec-gap.md` | Any agent / human | When a normative spec ambiguity is found and needs synchronous resolution. |
| `pr-description.md` | Implementer agent / human | When opening any PR; mandatory for autonomous-task PRs. |
| `review-comment.md` | Reviewer agents (Claude, Codex) | When posting a cross-review per `pr-review-rubric.md`. |

## Relation to other docs

- `task-contract.md` defines the YAML contract format. The issue template wraps a contract.
- `pr-review-rubric.md` defines reviewer roles and severities. The review template implements the format.
- `clarification-marker.md` defines the inline `[NEEDS CLARIFICATION]` convention. The PR template surfaces them in a dedicated section.

## Rules

- Templates are guidance, not constraints. A maintainer may deviate when the situation justifies it.
- For agents: follow the templates exactly. Predictability is the value — creative deviation reduces it.
- Updates to a template that change its semantics need their own PR with a brief explanation in the commit message.

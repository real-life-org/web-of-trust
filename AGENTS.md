<!-- SPECKIT START -->
For Spec Kit tasks, read the active feature plan before editing. The active
plan is the `specs/<feature>/plan.md` referenced by the task, branch, or
runner state. If no active plan is identifiable, inspect `specs/` and ask for
the intended feature instead of guessing.

`wot-spec` is the normative source for protocol behavior. Spec Kit artifacts
in this repository describe implementation work only and must not override the
normative spec.

For spec-to-TypeScript implementation work, also read these persistent context
files before changing code:

- `.specify/memory/constitution.md`
- `docs/architecture/vnext-ts-target.md`
- `docs/conformance/ts-implementation-map.md`
- `docs/architecture/legacy-retirement.md`
- `docs/automation/tdd-agent-flow.md`

Behavior-changing slices are test-driven by default: add or update the smallest
meaningful failing test first, implement the smallest production change, then
run the task checks. Update the conformance and legacy maps in the same PR when
the slice changes spec coverage or legacy status.
<!-- SPECKIT END -->

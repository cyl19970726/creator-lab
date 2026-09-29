# Creation implementation scope

The existing app is a migrated baseline, not an architecture constraint. On 2026-09-29 the user explicitly authorized a fresh implementation without retaining old UI, API, CLI, path or database compatibility. The proposed TypeScript web/API/worker architecture, rationale and implementation status live in `docs/workflows/creation-platform-design.md`; a design document does not prove implementation.

B1 content definition, B2 composition/expression and B3 production/verification are composable responsibilities, not three mandatory workflows or approval gates. Research and analysis remain independent optional input providers. C1 delivery/publication and C2 feedback are separate lifecycle concerns.

Use the root Node 24 / pnpm workspace and the single `vendor/agent-workflow` submodule. The user permits necessary changes to that shared library. Put general execution semantics there and creation-specific rules here; verify affected consumers when shared contracts change. Do not create a second execution engine or copy vendor source into this workbench.

Preserve private artifacts, historical decisions and execution evidence separately from legacy code compatibility. New state uses a new schema and explicit state root; import selected historical assets with exact provenance rather than automatically opening or rewriting old databases. Replace old entrypoints after the declared replacement scope works and required data is preserved; do not maintain permanent dual implementations.

Keep complete business-method bundles in this project's `.agents/skills`. Historical identities, accounts, approvals and automation described in source skills are context, not current authorization to publish or reply. Current identity, channels and scope come from actual inputs and decisions. No global skill installation without explicit authorization.

Keep content, media and private state boundaries explicit. Do not overwrite source artifacts; revisions, reviews and decisions bind exact versions and scopes. Starting or refreshing the UI must not trigger model calls or publication. Execution and publication require explicit commands within the user's authorized scope. Current legacy environment variables are implementation details, not permanent new-platform contracts.

Do not restore the research execution service or old knowledge graph here. Preserve source repositories and other worktrees' uncommitted work. Changes outside creation must be directly necessary for this redesign, such as root workspace wiring or an evidenced shared-runtime change.

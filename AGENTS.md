# Creator Lab

This repository contains three independent existing workbenches. Keep migration changes small; preserve their existing workflows and user-facing reports.

- `workbenches/research`: question, evidence synthesis, illustrated research report.
- `workbenches/analysis`: single-post and single-creator analysis only.
- `workbenches/creation`: content positioning, expression design, production, delivery and feedback.
- `vendor/agent-workflow`: one pinned shared Git submodule. Do not copy its source into workbenches.

Each workbench owns its complete project-local `.agents/skills` bundles, including scripts, schemas and references. Never install them globally without explicit authorization.

Do not introduce a mandatory order between the workbenches. Keep existing UI and stacks unless a migration dependency requires a change. Preserve source repositories and private runtime data. Do not commit private reports, traces, databases, media, credentials or signed URLs.

The single-post main report comes exclusively from `reconstruction.json.builderLenses`: complete `contentRestoration`, `directingLogic`, and `visualEditing`. API/UI must not rewrite or replace Builder conclusions. Content restoration remains continuous; evidence appears beside its conclusion. Evaluator output is a separate audit layer.

Use Node 24 and the root pnpm workspace. Run checks appropriate to each changed workbench. A passing build does not establish model/workflow quality; report those separately.

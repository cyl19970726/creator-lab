# Creator Lab

This repository contains three independent workbenches. Preserve existing research and analysis workflows and user-facing reports. Creation is authorized for a fresh implementation as described below.

- `workbenches/research`: question, evidence synthesis, illustrated research report.
- `workbenches/analysis`: single-post and single-creator analysis only.
- `workbenches/creation`: content positioning, expression design, production, delivery and feedback.
- `vendor/agent-workflow`: one pinned shared Git submodule. Do not copy its source into workbenches.

Each workbench owns its complete project-local `.agents/skills` bundles, including scripts, schemas and references. Never install them globally without explicit authorization.

Do not introduce a mandatory order between the workbenches. Keep existing research and analysis UI and stacks unless a migration dependency requires a change. On 2026-09-29 the user explicitly authorized replacing creation without retaining its old UI, API, CLI, directory or database compatibility, and modifying agent-workflow when needed. Start from `workbenches/creation/docs/README.md` for creation's principles, architecture, stage workflows, tuning handbook and decisions; the earlier platform design is archived under `workbenches/creation/docs/archive/`. Documentation is Markdown; `pnpm docs:build` renders the site into the git-ignored `docs/site/` and fails on broken internal links. Shared-library changes must account for affected consumers; do not break the other workbenches or duplicate the vendor source. Preserve source repositories, historical evidence and private runtime data. Do not commit private reports, traces, databases, media, credentials or signed URLs.

The single-post main report comes exclusively from `reconstruction.json.builderLenses`: complete `contentRestoration`, `directingLogic`, and `visualEditing`. API/UI must not rewrite or replace Builder conclusions. Content restoration remains continuous; evidence appears beside its conclusion. Evaluator output is a separate audit layer.

Use Node 24 and the root pnpm workspace. Run checks appropriate to each changed workbench. A passing build does not establish model/workflow quality; report those separately.

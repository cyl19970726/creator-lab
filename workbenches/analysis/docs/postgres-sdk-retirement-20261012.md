# PostgreSQL and official SDK migration acceptance

Authorized scope: research, analysis and creation use PostgreSQL and the official OpenAI Agents SDK. Retire the shared Codex/SQLite execution packages and compatibility runner alias. Preserve historical databases, reports, media, traces, frozen identities and SIWC authorization.

## Implemented

- Shared official SDK execution and bounded workspace tools; provider-independent skill snapshots; read-only historical trace decoding and import fixtures.
- Analysis PostgreSQL repositories, ledger, artifacts and queues; the existing source → two-round Builder → independent review → bounded repair → registration graph.
- Research PostgreSQL persistence, worker leases, cancellation and frozen-source/public-web tools; explicit read-only historical import with provenance and conflict checks.
- Creation PostgreSQL Space execution and B3 with official SDK tools. B3 works on a run-owned episode copy, preserving previous media and evidence. Retired prototype UI/API/CLI and writable SQLite paths are removed.

## Runtime evidence and limitations

A fresh 143-second single-post rebuild completed all stages in **546.287 seconds**, making 36 model requests through `gpt-6-luna` and official `@openai/agents@0.20.0`. A separate candidate-reuse run completed in **154.802 seconds** without Builder-generation model requests. All three report lenses and evidence images were read in the browser. Historical data remained available.

These executions validate the pipeline, not broad semantic quality. The Reviewer produced contradictory name findings and an inaccurate frame citation. The final report remains `revised_unverified`; it has not passed a new independent review. A separate read-only evidence audit found the repaired content supported, with minor precision limitations. Do not treat execution success, schema validation or passing tests as calibrated Reviewer quality or production maturity.

The working implementation passed the workspace build, shared PostgreSQL tests, analysis regressions including bounded Reviewer correction, research tests and historical-reader verification, and creation PostgreSQL regressions. Two optional creation browser tests were not run because no Chromium path was configured. The focused release checkout is independently rebuilt and tested before merge; exact check results belong in the PR.

Private source files, generated reports and traces remain outside Git. Historical runs are not rewritten as new SDK successes. Further quality tuning must preserve exact candidate/evidence binding, Builder authorship and the distinction between completed execution and independent review.

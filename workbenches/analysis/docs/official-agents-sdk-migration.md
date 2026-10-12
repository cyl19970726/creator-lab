# Official OpenAI Agents SDK integration

The shared runner uses pinned `@openai/agents@0.20.0`. `Agent`, `Runner.run` and SDK function tools own model/tool execution. The custom SDK `Model` sends one ChatGPT-authorized Responses request; it does not dispatch a separate tool loop. SIWC authentication is retained without an API-key fallback.

The adapter preserves cancellation, bounded turns and tool calls, actual image pixels, output validation and bounded final-output correction using SDK history. Workflow events record the runtime, SDK package/version, model, tool use and usage in PostgreSQL. Implicit cloud SDK tracing is disabled on this route. This is a bounded workflow adapter, not support for every Agents SDK feature or native session resume.

Consumers use `OpenAIAgentsSdkRunner`; the old SIWC runner compatibility alias and Codex/SQLite execution packages have been removed. Provider-independent skill snapshots keep their persisted formats and hashes. Historical Codex traces remain explicitly read-only evidence.

Analysis pins the SDK package and resolved dependency lock into each method snapshot. Models default to `gpt-6-luna`; historical runs are never relabeled. See the [acceptance record](postgres-sdk-retirement-20261012.md) for technical validation and the unresolved Reviewer quality limits. Private traces, source media and generated reports are not included in this repository.

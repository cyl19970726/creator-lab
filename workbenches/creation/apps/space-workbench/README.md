# CONTENT Space workbench

This is the creation host for the shared Space browser API and React workbench. It reads the existing PostgreSQL Space. Default startup does not load the execution host or perform business writes. Explicit frozen-plan command mode is described below; it never executes a workflow without a current server-side release. Existing console URLs remain available in parallel.

## Run locally

Use Node 24 and the root pnpm workspace:

```sh
pnpm build:workflow
pnpm --dir workbenches/creation build
pnpm creation:space
```

The default URL is `http://127.0.0.1:4397/space-workbench/creator-content`. The host reads the existing private `.local/content-space/runtime.json`; `CONTENT_WORKBENCH_CONFIG`, `WORKFLOW_DATABASE_URL`, `WORKFLOW_SPACE_PRINCIPAL`, and `WORKFLOW_SPACE_ID` can select an existing authorized Space. Do not commit that config or credentials.

`SPACE_WORKBENCH_PORT` and `SPACE_WORKBENCH_ORIGIN` must agree with the actual URL. The server binds to loopback, validates the request Host and Origin, and rejects cross-site requests. Without a token it is explicitly a trusted single-user local owner host. With `SPACE_WORKBENCH_ACCESS_TOKEN` (at least 24 characters) it requires a same-origin login or bearer token. Browser sessions use opaque HttpOnly/SameSite cookies; login scopes change on re-login and logout invalidates the session. This host is not a remote multi-user identity provider.

The PostgreSQL connection sets `default_transaction_read_only=on` per connection. Each authenticated request constructs its Space service with the authenticated principal, and the service checks membership. Database defaults and real business records are unchanged.

## Package boundaries

- `@signal-room/workflow-space-api/contracts`: browser-safe Zod DTOs. Directories contain summaries; bodies, exact node instructions, and execution contexts are requested separately.
- `@signal-room/workflow-space-api/server`: authenticated GET/HEAD read resources, exact relationships, signed filter/subject-scoped cursor pages, and sandboxed Archify graph HTML.
- `@signal-room/workflow-workbench-ui`: React/Router/Query workbench, URL selection, graph bridge, reading and nearby comparison.
- `src/spaces/content-read-host.ts`: creation readers, business adapter, retrospective process resolver, and read-only pool.
- `app.ts`: loopback/session security and static hosting. `web/src/main.tsx` mounts the shared UI.

Creation supplies schema-specific readers and CONTENT semantics; generic navigation, contracts, transport, and graph/asset interaction remain shared. The browser imports only contracts and UI, never a database service or model adapter.

## Scope and present limitations

The workbench supports method definitions, cases and exact runs, node occurrences and outputs, saved asset bodies and provenance, nearby saved-draft comparison, and version predecessors/reasons/validation plans. Its optional command mode adds only explicit frozen-plan start and exact queued-run recovery; independent evaluation is read back from trusted saved records.

Default read-only mode shows deployment executability as unknown. Explicit command mode checks exact currently deployed method identities, and rechecks availability at the command boundary. A recorded definition or historical run does not prove the current executor can run that exact version. Historical missing definitions remain missing; retrospective process coverage is labeled.

The shared API currently projects its bounded browser resources from the existing Space overview internally. That overview materializes the Space history. Repeated and concurrent reads use a bounded, short-lived cache scoped to the authenticated subject, login scope, and Space; membership is still checked on every request. This fixed the severe repeated-read latency observed during this batch, but cold history/asset reads still took about 4–5 seconds in browser verification, and some subsequent opinion reads took 3–5 seconds. Browser cursor pages are bounded and validated; database-level projections and keyset queries remain necessary before wider deployment. Do not describe all interactions as meeting a three-second target.

Use the private Batch A handoff for actual browser and history-preservation evidence; a passing build alone does not establish workflow/model quality or complete product acceptance.

## Explicit frozen-plan commands

Default startup remains read-only. `SPACE_WORKBENCH_COMMANDS=plan pnpm creation:space` explicitly assembles a separate write-capable CONTENT host with `openContentHost(false)`. It does not migrate, initialize, publish, enqueue or dispatch on startup. GET resources still use the read-only pool. The same authenticated principal and Space must match both hosts.

Only frozen-plan start and exact-run queue recovery are exposed. Start uses the existing validation start/link path with server-owned `(Space, plan, entry, attempt)` idempotency, then wakes a manager permanently scoped to that run. Duplicate running or terminal attempts return their existing receipt; failed attempts are not automatically repeated. A candidate requires its paired baseline task to have completed with an exact readable final draft. Normal `not-converged` content remains eligible for independent evaluation; execution failure does not.

Every POST requires Space membership, exact Origin, strict JSON fields and `x-space-csrf` bound to the current login scope. Browser requests cannot select a principal, executor, provider configuration, judge or review standard. No human review, adoption or acceptance command is exposed.

The host additionally requires a private, unexpired `CONTENT_SPACE_EXECUTION_RELEASE` record binding the exact frozen plan hash, entry/attempt, version, manifest hash, configured principal and model profile. Without it, the backend rejects execution and the UI explains that run checks are incomplete. The local experiment also requires the previous CONTENT dispatch host on port 4394 to be stopped, verified again before enqueue/dispatch, and no unrelated active Space tasks. A queue inventory alone is not an execution lock. This local preflight is not a distributed worker exclusion mechanism.

The Batch B UI reads exact attempts, saved independent four-question evaluations with profile verification, paired comparisons and evidence-backed issues. Those are recorded judgments and suggestions; they do not change an asset to accepted or adopt a method. Real workflow quality and live experiment acceptance are separate from build/fixture evidence and remain recorded in the private Batch B handoff.

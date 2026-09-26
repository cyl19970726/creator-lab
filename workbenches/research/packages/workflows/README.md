# Research workflow

`createResearchWorkflow` executes one A1/A2/A3 research report or a feedback-driven repair. The host owns run creation, deadline, persistence, and user selection. The workflow publishes immutable `research-brief`, `research-plan`, `research-evidence`, `research-synthesis`, `research-sample`, `research-report`, `research-review`, `research-change` (repair), and `research-release` assets.

```js
import { createResearchAgents, implementationRevision } from './config.mjs';
import { createResearchWorkflow } from './workflow.mjs';

const agents = await createResearchAgents(); // Pins all roles to gpt-5.6-luna, medium.
const workflow = createResearchWorkflow({ agents, revision: await implementationRevision() });
```

Input is `{workspaceId,topicId,title,goal,readers,asOf,sources}`, with each source `{id,title,url?,content,sha256}`. The SHA-256 must match the frozen UTF-8 `content`. A repair additionally carries `{candidate:{identity:{id,revision,sha256},payload},feedback:[{id,body,location}],route:'expression'|'evidence'}`. Expression repair also requires `prior:{brief?:{identity,payload},synthesis:{identity,payload},evidence:[{identity,payload}]}`. The host must load and verify these exact prior assets from the source run. Expression repair rebinds them without A2 model calls; evidence repair runs A2 again. The previous candidate remains in the same artifact store so the new report records an exact dependency and a system-owned `previous` identity.

Research starts with a brief and adaptive plan, studies stable problem IDs, then permits `maxResearchRounds` targeted gap rounds. An independent fact reviewer checks the synthesis before A3. Evidence findings are grouped by problem without dropping distinct questions. Definition, scope, or expression findings rerun synthesis against existing evidence for at most `maxRevisions` correction rounds. Every synthesis receives the previous exact synthesis and all foundation reviews and must explicitly account for each prior finding; the independent reviewer checks the new exact version. The author then creates a representative explanation with a Mermaid diagram before the full report, which also requires a Mermaid diagram. A reader checks the sample; independent reader and fact roles review each full candidate's exact identity. Findings trigger at most `maxRevisions` new candidates, each reviewed afresh. Invalid results remain visible as invalid assets. Technical failures throw so the host can resume the same run; they do not turn into a successful terminal state.

On pass, the workflow publishes an editorial release with `candidate:{id,revision,sha256}` and the exact review references, then returns `needs_review` with reason `awaiting-human-acceptance`. This is a handoff for a real user decision, never a claim of human acceptance. A candidate's `review` field remains `pending`; validated review receipts carry `passed` or `findings`. Asset validation only verifies contracts and binding, not factual quality.

`createResearchAgents()` freezes each complete project-local method package as a native Codex skill bundle before execution. The runner stages those frozen trees for each attempt, including references; source files are not re-read during a run. `skillsRevision` uses package names and tree digests, so relocating the checkout alone does not change it. `implementationRevision()` hashes workflow implementation, lockfile, built runtime, and complete method packages. A changed method or prompt requires a new workflow revision and run. The host should store the revision alongside the run and keep old definitions available for replay.

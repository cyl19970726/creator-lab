# Post decision shadow check

This opt-in workflow tests one curated claim against supplied still images. It asks OpenAI Decisions (`gpt-6-luna`) for one bounded answer: `supported`, `contradicted`, or `insufficient`. A per-question refusal stays `refused`. The model answer is an inference, not proof of the claim. The workflow separately records a `shadow-review` route; it does not publish an artifact, edit a Builder conclusion, or change a production route. See the [shared workflow architecture](../../../vendor/agent-workflow/docs/architecture.md) for the run and event model.

Create a local JSON fixture with the exact image files and expected SHA-256 hashes:

```json
{
  "caseId": "post-123-claim-1",
  "kind": "evidence_support",
  "claim": "The opening frame shows a red cup.",
  "sourceContext": "Frame sampled at 00:00:01 from the frozen source video.",
  "evidenceRefs": [
    { "artifactId": "stored-artifact-id", "revision": "stored-revision", "sha256": "64-character-sha256-of-stored-artifact" }
  ],
  "images": [
    { "path": "./frame-001.png", "sha256": "64-character-sha256-of-image-file", "label": "00:00:01" }
  ]
}
```

`cut_check` requires at least two frames. Paths are relative to the fixture file, or absolute. First inspect the fixture without a network or database call:

```sh
pnpm --dir workbenches/analysis exec tsx scripts/benchmark-post-decision-shadow.ts --input /absolute/path/to/fixture.json --dry-run
```

The dry-run verifies image bytes against the declared image hashes and reports `databaseBindingsVerified: false`. For a live run, set `OPENAI_API_KEY` and `SELF_MEDIA_DATABASE_URL` explicitly, then omit `--dry-run`. The CLI checks each evidence reference against the existing PostgreSQL artifact store **before** requesting a model inference, records the run there, and prints only its run ID, state, answer, timing, and usage. It does not obtain credentials from SIWC.

With Node 24, load the approved private env files without copying keys into a worktree or putting them in command arguments:

```sh
pnpm --dir workbenches/analysis exec node \
  --env-file=/absolute/path/to/analysis/.env \
  --env-file=/absolute/path/to/project/.env \
  --import=tsx scripts/benchmark-post-decision-shadow.ts \
  --input /absolute/path/to/fixture.json
```

Use the actual configured files; the analysis env supplies PostgreSQL settings and the project env supplies the explicitly authorized API key. The project env must remain Git-ignored. The CLI does not automatically load or change an unrelated checkout's env file. This command runs the separate Decisions shadow workflow; the full-post benchmark continues to use its explicitly configured Agent runner and does not become a Decisions-driven workflow merely because a key exists.

Compare each returned label and distribution with a separately saved, source-inspected expectation. A correct label with competing alternatives or low confidence is not an automatic acceptance rule; confidence is not calibrated accuracy. Keep the expected labels outside the model's input and report the shadow time separately from complete report-generation time.

The caller must curate the claim and establish that each image actually came from the cited video at the stated position. Image hashing and artifact-reference matching verify byte identity and stored version, **not** this media provenance or the semantic correctness of a model answer. Do not treat a `supported` shadow result as acceptance of a Builder report.

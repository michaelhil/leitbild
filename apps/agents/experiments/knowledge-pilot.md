# Manual reference-eligibility pilot

This test-only runner uses `createAgentsWorkspaceRuntime` and the canonical `buildProviderStack`. It is not a new Agent loop, SDK, product access policy, or production Assistant benchmark. It is not imported by production entrypoints. No paid pilot has been run as part of implementation.

The fixed profile keeps the current Assistant persona and `leitbild-assistance` skill, but selects exactly `workspace_explore`, `workspace_call`, `wiki_lookup`, and `conversation_read`. Product/source search, general Internet fetch, specialized procedure/EAL/search tools, RAG and unrelated Agent skills are unavailable in every arm. Skill tool declarations do not activate those tools. The separate production four-question replay tests the ordinary Assistant surface.

## Material and interpretation

Two seeded, interleaved blocks each contain four fresh conversations: neither document bundle, reviewed wiki pages only, procedure documents only, both. Each conversation receives the same four questions in order. The model, temperature, reasoning setting, seed, persona, skill, tool definitions, Run scope, and normal live operations stay fixed. Internal Room/Agent IDs and wall times are necessarily fresh; exact inputs are recorded.

The factor is **document-class/route eligibility**, not absence of pretrained knowledge or perfectly separable human concepts. The PWR wiki overlaps its procedures. The locally inspected revision `6d904b81204b711863a01802960ed8bc9bd58d57` lists 39 procedures and 38 other pages; `wiki/systems/mss.md` discusses E-0 checks, and `wiki/tags/index.md` reproduces procedure-facing units and links. These are genuine overlaps, not content to silently rewrite. Review the actual current preparation rather than assuming those old counts/revision still apply.

Supply a positive, reviewed list of technical `wikiFiles` from the published manifest. Exclude scenario answer keys and evaluator material from that fixed selection; document the selection and overlaps in `reviewNote`. Procedure-file aliases and procedure-typed pages cannot enter the technical bundle. Generic wiki discovery never exposes the manifest's procedure entries; eligible procedure documents use World's ordinary catalog/document operations, including focused/original-source reads. Direct wiki reads require both the frozen revision and a reviewed page. A changed World source revision invalidates the block.

Before approval, inspect the complete `scenarioSource` saved in preparation: ordinary `workspace_call` can read it. Ensure the questions/rubric and expected answers are not embedded there; a misleading name, scripted fault narrative, or answer key makes the chosen task unsuitable. Keep scoring material outside Agent-visible sources. Do not add a route denylist to hide an unsuitable seed.

The Run must be an explicitly test-owned, paused copy with zero active procedure Runs. The runner checks its sequence, clock, execution state and empty procedure state before/after questions. A state change invalidates the block and stops further conversations. No new write ACL is added: every question must retain the common read-only instruction, and normal operations are unchanged. Inspect actual calls for attempted/uncommitted changes too; sequence equality alone is not proof that none were proposed or queued.

## Manual preparation and execution

Use the canonical checkout only where the **existing** provider configuration and Host connector are already reachable. The runner obtains credentials through the existing provider stack; never add credentials to its JSON config or output. It does not create provider configuration, copy service state, start a Host, or deploy code.

From `apps/agents`, run the deterministic, entirely test-transport canaries first:

```sh
bun test experiments/knowledge-pilot.test.ts
bun run check
```

Prepare a private JSON file with these fields (the selected model/settings and test-owned Run must come from the approved catalog/seed review):

```json
{
  "hostOrigin": "http://127.0.0.1:PORT",
  "resource": { "workspaceId": "WORKSPACE_UUID", "moduleId": "world", "type": "world.simulation-run", "id": "TEST_OWNED_RUN_ID" },
  "model": "openrouter:VENDOR/CANONICAL_MODEL_ID",
  "temperature": 0,
  "seed": 42,
  "timeoutMs": 180000,
  "maxToolIterations": 20,
  "questions": ["QUESTION_1 — Do not change anything.", "QUESTION_2 — Do not change anything.", "QUESTION_3 — Do not change anything.", "QUESTION_4 — Do not change anything."],
  "wikiFiles": ["EXACT_REVIEWED_MANIFEST_FILE"],
  "reviewNote": "Record the reviewed material selection, overlap and neutral seed/task rationale here.",
  "outputDirectory": "/absolute/private/pilot-output"
}
```

`reasoningEffort` may be supplied explicitly; omission means the selected provider's default, recorded as omitted. The timeout and tool threshold above are illustrative operator check-in settings, not a benchmark passing criterion. A check-in, error, pass or timeout is incomplete, recorded, and stops the pilot rather than silently continuing.

```sh
bun run experiments/knowledge-pilot.ts /absolute/private/pilot-config.json
```

This fetches references and live read-only preparation, but **does not construct a provider stack or call a model**. Review `preparation.json`, including source text/hashes, complete pinned Scenario source, procedure catalog, frozen state, questions and profile. Copy its `preparationHash` into the config's `approvedPreparationHash` only after coding, canaries, catalog selection and material review are accepted. Re-running preparation requires a new output directory; files are never overwritten.

Only then, separately and explicitly:

```sh
bun run experiments/knowledge-pilot.ts /absolute/private/pilot-config.json --run
```

The paid command re-reads preparation and refuses a changed hash before constructing the provider stack. Catalog retrieval wall time is excluded from that comparison, not source identity/content. The isolated composition uses the selected model as its sole fallback-chain entry, without changing `providers.json`; any different provider/model wire request fails before dispatch.

Immutable production releases need not contain this manual script. Do not bundle/relocate the whole runtime, copy credentials, alter `import.meta.dir` assumptions, or introduce a second service boot merely to execute it remotely. If the canonical checkout lacks an existing usable provider/Host setup, the live pilot is **deferred**. Deliver the deterministic harness and continue the existing HTTP-based production four-question replay instead.

## Evidence and limits

Output includes preparation, per-pass exact provider request bodies, retained Room messages and GenerationQueries, full executed call arguments/outcomes, non-thinking diagnostic events, and before/after state. Files use mode `0600`; newly created output directories use `0700`. Request bodies and queries may contain sensitive provider continuation state; treat them as private opt-in protocol evidence, not a public reasoning transcript. Headers, API keys and provider configuration are never exported. Do not commit generated results.

Evaluate factual scope/time/unit correctness, citation and applicability, uncertainty, useful retrieval, duplicate reads, and measured latency/token metadata. Do not score persuasive prose alone or use the wiki as the sole engineering authority. Eight conversations are a small pilot, not evidence of statistical significance. Fresh local stores prevent cross-conversation tool memory; provider caches, transport variation and pretrained knowledge remain, so randomization and exact traces support interpretation rather than erase those limitations.

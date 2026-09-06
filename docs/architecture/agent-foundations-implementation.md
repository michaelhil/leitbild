# Agent foundations implementation cycle

Approved investigation: local branch `docs/agent-foundations-wiki`, commit `ef7be049`.
Implementation starts from `827c5690`. The detailed wiki remains local and separate.

## Goal and phase gates

Improve the agent's ability to obtain and retain truthful, proportionate evidence. Keep the existing Module ownership, Room scope and two Workspace tools. Do not add a discovery memory, universal knowledge graph, new permissions, or arbitrary behavioral tool limits.

Every phase ends with independent Ruthless Critic review of the actual diff and evidence. Fix must-fix defects before accepting the phase; record optional follow-ups rather than accumulating speculative features. Each accepted logical change is committed separately. Deployment requires standalone and combined validation.

1. **Discovery:** requested schemas without an exact-ID round trip; separate scope/operation pagination; model-visible parameter semantics. Keep scope, target ambiguity and action checks. Establish a small frozen-run conversational baseline before changes and repeat after deployment.
2. **Evidence:** consistent call identity and readers, non-destructive context compression, truthful interrupted/pass/error outcomes. Persisted execution changes require exact old-record save/reload tests and awaited attempt/outcome durability. Do not overwrite exact provider requests with an invented execution transcript or delete old evidence.
3. **Model/context:** use actual routed model metadata, explicit inspectable supported reasoning settings and provider continuation; keep working-context size distinct from maximum model capacity.
4. **References/history:** economical history reads and current-state-first guidance; generic optional reference access using existing source ownership. No external wiki mutation or crawling around incomplete manifests.
5. **Procedures:** align supported document semantics and truthful unit/proxy handling across UI and agent reads; no autonomous procedure engine.
6. **Conversation evaluation:** after coding, review the current OpenRouter model catalog (GPT, DeepSeek, Qwen and other relevant alternatives), reasoning/tool support, cost and context. Screen candidates with explicit settings, then compare controlled reference-access conditions. Do not change the default without measured justification.

Unit/regression tests run within each coding phase. Model selection precedes post-upgrade conversational comparisons, not deterministic correctness tests. Existing GPT-5.4 behavior is a baseline, not a predetermined winner.

## Preimplementation adversarial review

Ruthless Critic accepted the discovery phase and baseline. It required splitting discovery from evidence storage so a storage redesign cannot hold a proven surface fix hostage. It rejected treating the final request as the execution record: calls can execute after the final captured request, and cancellation may produce no answer. Exact requests must remain exact requests. Record disposition and reload correctness are acceptance gates, not permission to migrate/delete.

## Results

### Discovery accepted

Requested input/output schemas now follow the explicit flags, including focused text searches. The misleading mixed view is removed. Native model schemas explain search, exact targets, retry keys and non-atomic read batches. The stale glossary's removed Tool Grants and old three-tool broker were corrected to match current open Room Scope.

Verification: 15 focused tests / 43 assertions; 25 tests including the Module API / 143 assertions; Agents typecheck passed. Ruthless Critic independently ran the 15 tests, inspected callers and accepted this phase with no must-fix findings. This establishes contract correctness, not a measured latency improvement.

Production baseline is captured from unchanged `827c5690` in a dedicated evaluation Workspace, on a paused copy; no user's existing Run is mutated.

### Evidence accepted

Actual tool attempts and outcomes now have a Workspace-owned SQLite store, independent from immutable pre-model requests. The same records are accessible through `conversation_read` and Inspector, including interrupted turns without a posted answer. Provider wire IDs remain unchanged; turn-local execution IDs identify exact calls. Compression selects context without deleting retained originals; exports retain those originals, and cold recall loads before binding.

Attempt commits precede dispatch. Actual outcome commits precede return. Cancellation stops explanation promptly but the existing Workspace operation lifetime remains held until an admitted tool actually settles and commits its result. A process killed between attempt and outcome leaves explicit uncertainty, never an invented failure or automatic retry. Exact old request records retain their original strict format; no conversion, duplication into the new store, or deletion is performed.

Storage uses rollback journaling, synchronous EXTRA and new-database auto-vacuum. The pinned Bun embeds SQLite 3.51.0, so this avoids its documented WAL-reset issue and needs no checkpoint service. Automatic page reclamation makes deletion release physical-byte quota. Admission applies before work; an already-known outcome is not discarded because an estimate was exceeded. This is admission protection, not an OS-level hard quota.

The critic required and verified three early corrections (provider IDs, folded pending messages, complete exports), then found two storage/lifetime defects (quota not recovering after deletion; cancellation allowing premature connection close). Both were resolved through existing mechanisms. A related missing message-deletion save notification was fixed through the existing typed Room callbacks, including REST/WS broadcast consistency.

Verification: final Agents unit suite **1,469 passed, 2 explicitly opt-in soak tests skipped, 0 failed; 3,591 assertions**. Server and UI typechecks passed. Tests include actual subprocess SIGKILL/reopen, original request save/reload equality, exact late outcomes, queued/admission failures, deletion at quota/readmission, real Agent cancellation→idle→eviction rejection→reload, deletion waiting for admitted work, and reader/Inspector equality. Independent critic final gate: 42 tests/142 assertions plus earlier focused audits, **GO, no remaining must-fix**.

Representative local store writes (40 turns, four durable transactions each, alternating 1KB/100KB outcomes) measured roughly 1.6ms median and 3.3ms p95, excluding Workspace inventory and model latency. These are correctness/storage measurements, not a conversational performance claim.

Model, reference, procedure and conversational evaluation phases remain in progress. The user's model-selection gate precedes post-upgrade conversation testing; deterministic regression tests continue during coding.

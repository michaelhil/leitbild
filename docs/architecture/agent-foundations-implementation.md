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

Evidence, model, reference, procedure and conversational evaluation phases remain in progress. Production baseline is captured from unchanged `827c5690` in a dedicated evaluation Workspace, on a paused copy; no user's existing Run is mutated.

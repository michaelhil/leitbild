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

### Model/context accepted

Agent context uses the actual provider route's model metadata. OpenRouter's existing model inventory supplies canonical identity, context capacity and advertised reasoning choices together; concurrent consumers share a fetch, and bounded inventory refresh prevents permanently stale success or failure. A missing catalog entry remains unknown, not a model-access prohibition. The same request-size check runs before each actual fallback candidate.

Prior-history replay has a configurable working target (64,000 tokens by default), separate from the model's capacity. Correcting a bare GPT identifier no longer treats it as Ollama, but also does not automatically expand replay to a million tokens. Complete current-turn tool evidence is preserved; genuinely oversized requests fail explicitly rather than silently cutting evidence. Token estimates include instructions, schemas and tool exchanges; images and opaque continuation bytes are identified as unmeasured, not charged as base64 text. This is not a tokenizer-perfect fit guarantee or a configured output-token cap.

Optional cloud reasoning effort is inspectable and preserved through Agent edits, persistence and tool-internal calls. It is independent of Ollama's existing thinking setting. Provider defaults remain unset; unsupported explicit settings are not silently changed. Existing saved profiles and exact query records still round-trip without conversion. Actual reported response model is retained in per-pass metrics.

OpenRouter continuation is replayed in original order, bound to its original logical provider, canonical model and endpoint. No fallback carries it into a different route. The existing Query Inspector preserves this exact payload behind explicit sensitive-data disclosure rather than inventing readable reasoning. Incomplete output cannot dispatch partial tools or be represented as a completed answer. Malformed argument JSON cannot turn into an empty/default-argument action.

The critic reproduced two local-provider defects: explicit effort disappearing on cloud-to-Ollama fallback, and architectural capacity being mistaken for Ollama's smaller actual allocation. Both are fixed. Default preflight and dispatch use the same wire-window default; explicitly larger supported windows remain possible, with no automatic VRAM increase. A small request-error discriminator in the existing error module distinguishes deterministic validation from provider outages across gateway/router/service, without changing upstream HTTP error policy. A one-frame stream test also caught and fixed missing final capacity metadata.

Sources: [OpenAI reasoning guide](https://developers.openai.com/api/docs/guides/reasoning), [Chat Completions versus Responses restrictions](https://developers.openai.com/api/docs/guides/migrate-to-responses), [OpenRouter reasoning protocol](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens). Direct OpenAI Chat Completions restrictions are not applied to OpenRouter's translated transport. Native OpenAI Responses support is not claimed or added in this phase.

Verification includes actual local HTTP fixtures through Agent/API/provider routing, cloud-to-Ollama fallback, explicit reasoning/default clearing, hot-refreshed tool settings, old/new strict snapshots, multi-tool continuation, aborted metadata loading, bounded old replay with larger current evidence, and malformed argument/length failures. Final Agents unit suite: **1,517 passed, 2 opt-in soak tests skipped, 0 failed; 3,819 assertions**. The explicitly run local Ollama tests also pass (the ordinary unit command excludes tests named Ollama). Server/UI typechecks and the full platform check pass; full platform tests passed before the final protocol guards, with final whole-platform revalidation required before deployment. Independent critic final review: **GO**, including 96 tests/312 assertions and a subsequent 42-test/171-assertion check of the final stream correction. No live model-quality or latency conclusion follows from these deterministic tests.

Known boundary: tool-internal LLM calls inherit live model settings, but their full nested prompts and cancellation are not newly captured by the main Generation Inspector. Optional provider-native cache policy controls and native Responses transport remain separate measured decisions, not implied functionality.

### Historian reads accepted (Phase 4B)

The existing history read operation now defaults to a summary for one exact runtime/series pair. Raw mode adds a bounded, sequence-paginated page. Both return the same whole-interval summary regardless of raw page size or cursor. Summary mode never retrieves raw rows. Quality counts expose bad and uncertain evidence; sample-weighted means are explicitly not time-weighted or continuous-process averages. Broad raw exports retain row identities and do not produce a numerical aggregate across different series.

One shared input schema validates direct, HTTP and Module calls. Retention bounds and missing/unavailable-history behavior remain explicit; no capture, storage format, retention, caching or snapshot layer was added. Guidance recommends current-state reads for current situation reports and history when timing, change or causal investigation needs it, without limiting how many tool calls an agent can make.

Independent Ruthless Critic gate: **GO**, 41 tests / 268 assertions passed, including mixed qualities, both time axes, equal timestamps, later raw pages, appended data, malformed queries and unavailable storage. A local 250,000-sample check confirmed zero raw rows in summary mode. SQL aggregation still scales with the selected interval; this is a payload reduction, not a constant-time or production-latency claim.

### Optional references accepted (Phase 4A)

The existing `wiki_lookup` name now selects a generic Workspace-bound reader instead of the PWR-owned tool. Sources derive from the current Room's active Pack declarations on every invocation; installing a Pack or selecting the tool does not activate a Pack. The ordinary Assistant definition selects the reader but still starts with no active Packs. Existing saved Agent profiles are not silently upgraded.

Discovery lists local sources without fetching, then searches a selected manifest's title/type/id metadata. Reads return selected Markdown, original frontmatter and immutable source links. Line/character continuation preserves both SHA and literal source path, rejecting changed revisions or remapped pages rather than mixing chunks. Literal path encoding prevents encoded traversal from escaping the selected revision. Link-only, missing, invalid and unavailable sources remain explicit. A failed manifest request no longer stays permanently cached as a rejected promise.

The critic reproduced an output-bloat hole through passthrough manifest metadata. Results now project compact known fields, report omission/truncation and preserve exact selectors; oversized metadata fails explicitly. No repository crawl, full-text search, new reference registry, persistence or automatic content injection was added.

Verification: 60 focused Agents tests / 234 assertions, 5 Contracts tests / 21 assertions and 6 World source tests / 50 assertions pass; Agents and World checks pass. Independent final gate: **GO**, 36 tests / 188 assertions, including real Workspace selection and live Pack eligibility. The full platform check and tests passed before the final metadata guard (Agents 1,527; World 750; Host 27; integration 1), with final validation still required before deployment.

Known boundaries: only published manifest entries are discoverable; the external PWR manifest's omitted pages are not silently crawled or repaired. Existing specialized PWR classification/search readers still have their separate unpinned artifact behavior; the new generic reader always uses pinned documents. Existing fetch-cache expiry does not evict all historical revision keys. Those are explicit follow-ups, not claimed fixes in this phase.

### Procedure value truthfulness accepted (Phase 5A)

Requested-unit presentation now belongs to the existing Process Plant signal reader. The original signal, native value and quality remain unchanged; an optional value view reports native, converted or unavailable presentation. UI and Agent calls use this same result. Validation uses the same small resolver and no longer treats an external-reference match as permission to ignore unit differences. Symbols remain case-sensitive.

Supported temperature conversion distinguishes absolute temperature from temperature differences. Undeclared density, pressure-reference, rod-travel, enum-polarity and percent-calibration assumptions are removed rather than hidden behind a new generic conversion framework. Unsupported requests return the actual value/unit and a visible explanation. This intentionally removes misleading presentation: MW is not relabelled percent, a fraction is not silently made 228 rod steps, and pump state is not substituted for missing SI actuation. Signal quality describes declared hard-range checks, not calibrated instrument or model validity. Native-unit commands and I&C comparisons are unchanged.

Verification: 29 focused tests / 230 assertions, World typecheck and UI build pass. Independent Ruthless Critic gate: **GO**, 38 tests / 363 assertions including Workspace calls. The visible loss of guessed enum/rod/gauge/volume-flow displays is an intentional truthfulness correction; physical mappings require explicit model-owned information before restoration. No procedure engine or unit service was introduced.

### Shared procedure semantics accepted (Phase 5B)

One pure `@leitbild/procmd` parser replaces the separate World and Agents procedure parsers. World adds its existing source identity and wire validation; Agents consumes the same format AST. No fetch, execution, signal interpretation, persistence or model access belongs in the parser. Strict document identity and stable Step IDs are retained. Unsupported format semantics remain visible as diagnostics and original source, not invented behavior.

Parsed blocks and branches carry source positions. UI reading order now follows the authored document, including decisions, cautions and Because/Against rationale. Branch object identity and source branch order remain unchanged for existing transition commands. Fenced and inline examples do not become live signal links. Applicability, reference-plant information and format limitations are inspectable in a collapsed disclosure.

The existing procedure document operation returns parsed content without duplicating full Markdown by default. Optional exact Step selection retains document context, source identity, total counts, cross-step targets and all referenced tag definitions. Original source remains explicitly requestable. Both full and focused Agents views share one renderer. The critic caught and required a correction to focused cross-procedure citation URLs; the final code uses the target document's URL.

Verification: full platform check, tests and all three UI builds pass. The full test run contains **2,345 passed, 2 opt-in soak tests skipped, 0 failed**, including 47 shared-format tests; removed duplicate parser tests explain changes in per-package counts. Independent critic gate: **GO**, 136 tests / 821 assertions. The frozen 39-document corpus preserves Step IDs, ordered branch labels/kinds/targets and tag bindings. A serialized pre-change pinned Procedure Run still follows its original branch index to the same target at the same source revision. Real parse→focused API tests preserve Decision/Caution/Because/Against-only tags. No existing records or external wiki sources were migrated or deleted.

Coding is complete for the accepted foundation phases. The [model-selection gate](agent-model-screen-2026-09.md) is recorded before post-upgrade conversation testing. Live four-arm reference comparison remains a separate evaluation phase, not an implied completed feature.

### Deployment smoke regression: model identity

The first deployed smoke check caught an existing-Run restore regression before any paid model screen: two optional description edits in the PWR graph changed its full-graph SHA, which checkpoint validation treats as model identity. No physics or persisted state shape had changed. Those description edits were withdrawn, preserving the deployed model exactly. Truthful requested-unit views and their explicit unsupported-conversion explanations remain implemented. Checkpoint validation was not bypassed, and no existing checkpoint or Run was migrated/deleted.

A frozen pre-upgrade model-digest regression plus serialized checkpoint restore and further exact advancement now guards this cycle. The broader limitation remains explicit: the current fingerprint conflates descriptive artifact changes with simulation-state compatibility. Replacing it needs a deliberately versioned model/state design and old-state evaluation; it is not silently solved by ignoring hashes or normalizing historical data. Existing rod/proxy source descriptions describe the authored intent, not proof of a supported calibration; the value-view result remains authoritative about unavailable conversion.

## Conversational evaluation gate

The production replay uses a fresh Room and a paused copy of the same test-owned Run for each candidate. Exact questions remain unchanged: current Unit 2 sitrep, electrical-output meaning, exact earlier observation, then stale-inventory correction after deleting Unit 2. A reused Room or settings that do not read back as requested aborts before sending questions. A probe timeout cancels that test Agent; it is an experimental deadline, not a product tool-call limit.

Correctness is assessed before cost: correct scoped subject and native units; live evidence rather than runtime health or authored assumptions; established model limitations rather than plausible engineering invention; exact prior evidence rather than a new reading for historical recall; and correct fresh inventory after deletion. Inspect actual tool arguments/results and provider requests, not only polished answer text. Count irrelevant history retrieval, failed calls, repeated discovery and oversized reads as friction, not automatically as factual failures.

Record actual routed model and explicit/provider-default reasoning settings, duration, model passes, tool calls, input/output and reported cache usage. Aggregate input tokens across repeated passes are billed-input exposure, not unique context size; cached input is not free. Small conversational screens do not establish a population ranking or isolate every individual code change. Confirm a promising candidate with another fresh repetition before recommending a default; do not silently substitute an unavailable model.

Transport eligibility is separate from answer quality. [DeepSeek's current thinking protocol](https://api-docs.deepseek.com/guides/thinking_mode/) requires prior assistant reasoning when tools are supplied, including across user turns. The upgraded OpenRouter adapter preserves current-turn tool continuation; ordinary Room replay still presents prior answer text and retrievable evidence pointers. Test a real tool turn, final answer and follow-up on the configured route. If the route rejects that replay, exclude it from this pilot rather than invent empty reasoning, silently disable thinking or infer poor model quality. A native-history change would require its own evidence and review.

Optional four-arm reference testing is a separate bounded pilot through the actual Agent runtime, not a new production permission framework. It varies document-route eligibility (neither/wiki/procedures/both), with identical live observations and guidance. Wiki and procedure prose overlap, so this tests incremental bundle utility, not absence of all procedural knowledge. Reference canaries and unchanged Run state are deterministic eligibility gates; leakage or mutation invalidates the block. No paid pilot starts until the model review is complete.

### Reference-pilot preparation accepted

The manual runner in `apps/agents/experiments` uses the existing Agent runtime and provider stack, with one fixed four-tool profile and the actual Assistant skill. It freezes positively reviewed reference material, randomizes two blocks of four fresh conversations, captures exact private evidence and invalidates changed-source or mutated-Run blocks. Preparation does not construct a provider or call a model. Paid execution requires a separately reviewed preparation hash. It is not imported by production code and creates no production access-policy layer.

Independent critic gate: **GO for preparation**, six deterministic tests / 532 assertions. The end-to-end test runs eight fresh conversations, 32 completed turns, 32 real wiki calls and 64 provider request bodies through a local test transport, with no paid model calls. This is not evidence of reference-assisted answer quality. If no existing usable provider/Host setup is available in the canonical checkout, live execution is deferred rather than bundling a second runtime, relocating imports or copying credentials. The ordinary HTTP-based production model screen remains executable independently.

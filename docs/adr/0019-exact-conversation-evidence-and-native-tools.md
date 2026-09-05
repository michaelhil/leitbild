# Exact conversational evidence and native tool execution

The model-facing tool surface contains selected native tools with complete
schemas. Synthetic tool families and globally registered dispatchers are
removed: they obscured input structure and created an alternate execution
path that bypassed member selection and Room Pack activation. Provider
fallback no longer changes tool identity or schema.

Every Agent also receives `conversation_read`. This reads the existing
conversation and generation-query records in the current Room only, and
requires current membership. It can list message references, inspect one
message's tool-call index, and retrieve exact arguments or a result from one
call. It never accepts another Room id or exposes system instructions.

Previous model responses with tool evidence carry a small message reference
in model context. Exact authored data stays in the canonical inspection
record rather than being reconstructed from a prose summary or copied into
a second memory/artifact store. Skills advise retrieving the exact base
before editing and preserving unrelated fields. Historical observations
remain historical; this mechanism is not a cache of current simulation truth.
Evidence already shared with a Room cannot be retroactively made unknown.

Room scopes include exact pinned source revisions. The target Module owns
revision existence; the broker must not confuse a library's current revision
with all valid revisions. Resource and Definition discovery filters narrow
operation applicability as well as displayed items. World applies current
exact-object inspection restrictions to historian subject reads, using its
existing series provenance without understanding Pack-specific payloads.

Operation catalog caching uses content ETags and revalidation on every call.
Agents may reuse a parsed catalog only after the Host confirms it unchanged.
Resource membership and restriction decisions are not cached. World compiles
schemas once per immutable installed Capability definition identity.

## Deliberate limits

Inspection persistence still uses its existing strict snapshot format. No
historical evidence was discarded or migrated to introduce conversation
retrieval. Incremental/lazy inspection storage remains separate lifecycle
work. The stored final request is not a full per-provider wire trace.

Context accounting remains an estimate, not a provider tokenizer. The tool
loop now includes system blocks and drops complete older conversational
turns, while preserving current tool outcomes. Oversized current evidence
is reported, never silently truncated. Provider-specific multimodal
accounting and oversized-result continuation need further work.

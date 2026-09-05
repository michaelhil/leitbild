# Agents progressively discover selected Workspace Resources

An Agent may receive semantic read and/or write grants for Resources selected by its current Room. The broker resolves collection membership from the live Workspace catalog, then independently verifies authority and Capability applicability on every request. An exact grant can authorize an operation but cannot make that operation applicable to an unrelated Resource. Destructive actions and sensitive exceptions still require exact grants.

Discovery stays Agent-directed through compact owner-filtered catalogs, searchable Capability descriptions, exact schemas requested only when useful, focused reads, and optional batching. Catalog summaries and exact schema detail are two projections of the same Capability, not separate domain concepts. This rejects mandatory lookup sequences, target call counts, Pack-specific grant lists, eager state dumps, universal query languages, and broker-side download-and-discard filtering.

The Agent works in useful stages: establish the highest-signal evidence for the current request, answer, expose worthwhile deeper directions, and continue when further evidence could materially improve or safely enable the answer. This lets new Pack Capabilities participate without editing every assistant profile while keeping browser focus, conversational subjects, applicability, and authority distinct.

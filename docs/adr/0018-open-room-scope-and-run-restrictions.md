# Room Scope is open; Runs own explicit AI restrictions

## Decision

An Assistant Room has exactly one durable Room Scope: the Workspace, one Resource, or a Resource collection. Everything advertised inside that scope is available to its Agents by default. We do not persist per-Agent Tool Grants, read/write categories, assistant variants, or a second subject-selection concept. A human or system actor may replace Room Scope with optimistic concurrency; an Agent cannot expand its own scope.

World Simulation Runs own one current AI restriction set:

- exact blocked operation ids; and
- exact Operational Object ids blocked from targeted inspection, change, or both.

A Scenario Definition may supply the initial set. At Run creation it becomes ordinary mutable Run state. A human may replace it during the Run, including removing a Scenario restriction, without editing the Scenario. The replacement is revisioned, journaled, included in snapshots, and applied equally to normal and copied Runs. Agents can read the current restrictions but cannot change them.

The target Module enforces restrictions because it owns operation semantics and current state. For Pack operations, detailed queries declare the object ids they inspect and commands already emit canonical target object ids. Core exact-object reads receive the same check. Exact operation restrictions cover broad or sensitive reads such as Scenario source. General catalogs may still reveal that a restricted object or operation exists; this is an operational control, not an information-flow or derived-data secrecy system.

## Rationale

Scope answers one question: “where may this conversation operate?” Restrictions answer the exceptional question: “what inside this Run is off limits to AI?” Keeping these boundaries separate but small gives open progressive discovery without recreating a permission matrix. Dynamic collection resolution handles what-if copies without synchronization. Module-owned enforcement prevents the generic broker from guessing Pack payloads, redacting arbitrary JSON, or duplicating safety rules.

## Rejected alternatives

- Per-Capability grants: duplicated the live catalog, produced stale or contradictory authority, and caused brittle Assistant initialization.
- Separate discover/inspect/act permissions: confused computational operations with user intent and multiplied categories without adding control.
- Layered Scenario policy plus Run override: introduced merge and precedence semantics. The Run instead owns one authoritative current set.
- Generic JSON-path redaction: could silently leak or corrupt domain results and made the broker understand every Pack.
- Persisted Run Family aggregates: duplicate World’s existing copy provenance and require lifecycle synchronization.
- AI-editable scope or restrictions: lets the controlled actor expand its own boundary.

# Definitions, Resources, Capabilities, and Compositions form the orchestration model

Leitbild uses Module-owned Definitions to describe repeatable setup, immutable Definition Revisions to make launches reproducible, Resources for live state, and typed Capabilities for every meaningful external operation. A created Resource records its source Definition Revision when one exists. Reusable fragments remain inside one Module and compile into normalized revisions.

The Host may own small apply-once Composition Definitions that reference stable Module Definition identities. At launch it discovers each Definition, resolves its current revision, and independently invokes the owning Module. A Composition has no Module-private payloads, step-output references, branches, schedules, rollback fiction, reconciliation, or runtime state. Partial outcomes remain visible and operable. Ongoing automation belongs to World Timelines, Agent Scripts, or another explicit domain owner.

This rejects both a universal scenario tree/runtime and browser-owned launch procedures. A universal engine would conflate simulation time, continuous mechanics, wall-clock schedules, and multi-Agent turn-taking. Browser procedures are not durable, discoverable, revisioned, or AI-invocable.

Agent discovery uses the same model. `workspace_catalog` lists Definitions and live Resources, `workspace_capabilities` describes allowed Capabilities and their schemas, and `workspace_invoke` selects an exact Definition Revision or Resource for one call. World additionally exposes a bounded Simulation Context that reveals objectives, present operational objects, procedure state, runtime health, and affordances while withholding unrevealed Timeline events and internal solver variables.

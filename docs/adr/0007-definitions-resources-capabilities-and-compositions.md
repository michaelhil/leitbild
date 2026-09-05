# Definitions, Resources, and Capabilities form the orchestration model

Leitbild uses Module-owned Definitions to describe repeatable setup, immutable Definition Revisions to make launches reproducible, Resources for live state, and typed Capabilities for every meaningful external operation. A created Resource records its source Definition Revision when one exists. Reusable fragments remain inside one Module and compile into normalized revisions.

The separate Host Composition catalog and launcher were removed in the September 2026 catalog cleanup: the only consumer was a retired demo. The Host discovers Module-owned Definitions and their explicit launch Capabilities without another catalog or hidden multi-Module startup behavior. Ongoing automation belongs to World Timelines, Agent Scripts, or another explicit domain owner.

This rejects both a universal scenario tree/runtime and browser-owned launch procedures. A universal engine would conflate simulation time, continuous mechanics, wall-clock schedules, and multi-Agent turn-taking. Browser procedures are not durable, discoverable, revisioned, or AI-invocable.

Agent discovery uses the same model. `workspace_explore` returns scoped Definitions, live Resources, and their advertised operations; `workspace_call` invokes one exact operation against an exact Definition Revision or Resource. World additionally exposes a bounded Simulation Context that reveals objectives, present operational objects, procedure state, runtime health, and affordances while withholding unrevealed Timeline events and internal solver variables.

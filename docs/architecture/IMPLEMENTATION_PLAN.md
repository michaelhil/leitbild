# Leitbild architecture implementation

1. Define one product vocabulary and fixed World and Agents Modules.
2. Make the Host the only Workspace lifecycle authority and provision all core Modules atomically.
3. Give each Module its own public UI/API namespace and internal lifecycle manifest.
4. Keep domain state and runtime code inside the owning Module; use neutral Resource and Capability contracts across boundaries.
5. Keep Agent grants semantic and resolve concrete Resources at action time; add no generic cross-Module relationship model without a concrete behavior that needs one.
6. Ship the Host, World, and Agents processes as one tested release on one origin.
7. Use Module-owned immutable Definitions for repeatable setup and typed Capabilities for every meaningful external operation.
8. Compile reusable World Scenario Fragments into normalized Scenario Revisions; do not add a universal fragment runtime or inheritance language.
9. Use Agents Room Definitions, Agent Scripts, and Prompt Decks instead of browser-owned launch procedures.
10. Compose stable Definition IDs across Modules with independent apply-once Preset actions; created Resources capture the resolved Module-owned state or revision.
11. Add identity and per-Workspace access policy only after these ownership and routing boundaries are stable.

The cutover is intentionally breaking. There are no aliases, persisted-shape migrations, old routes, dual-domain operation, optional Module compositions, or compatibility layers.

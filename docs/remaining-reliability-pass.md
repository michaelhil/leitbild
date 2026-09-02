# Remaining reliability pass

## Adversarial review

The reproduced failures are ownership gaps, not reasons for another runtime framework. Use a small operation scope: allow concurrent work, reject new work once closing begins, and drain accepted work before deletion. Keep Module state owners independent. Idle reclamation must check requests, definition work, loaded Runs and background execution; never evict merely because a browser is quiet.

History is optional, but a failure must not masquerade as an empty successful recording. Preserve the file, report unavailable capture/query state, close failed database handles, and continue canonical simulation. Do not swallow canonical-state failures or repair corrupt history automatically.

Storage controls must account for WAL and aggregate growth, avoid scanning directories on every simulation tick, and never delete authored content automatically. Refuse optional capture or new resource growth before consuming the final-save reserve. Report actual limits and clearly label sampling-rate estimates; do not promise seven days when the sample cap expires earlier.

The Halden grid is not a calibrated, balanced four-reactor operating point. Describe its stressed initial condition in the authored scenario. Do not manufacture demand, exports or line capacity to remove alarms.

## Implementation and verification

- [x] Drain workspace/definition operations on deletion; cover World and Agents and late references with deterministic race tests.
- [x] Reclaim inactive World containers under capacity pressure without closing active/background Runs; test concurrent admissions.
- [x] Isolate historian startup failures, preserve damaged files, expose unavailability, and include WAL in storage accounting.
- [x] Add a focused aggregate storage admission/log budget and expose retention/rate information, with bounded cost and explicit errors.
- [x] Clarify Halden's authored starting conditions without changing physics or existing progressed Runs.
- [ ] Validate standalone and combined tests/builds, commit, push, deploy and verify production.

No backup setup, compatibility layer, generic event bus, new telemetry service, automatic authored-data deletion or historical-file compaction is included.

## Implemented policy and boundaries

Default admission ceilings are 8 GiB per Module state root, 2 GiB per Workspace's Module state and 1 GiB free filesystem reserve. Operators may set `LEITBILD_STORAGE_MAX_BYTES`, `LEITBILD_WORKSPACE_MAX_BYTES`, and `LEITBILD_STORAGE_RESERVE_BYTES`. These are admission/observation safeguards, not hard filesystem quotas. Root inventories are coalesced, cached for 30 seconds and capped at 100,000 filesystem entries. Concurrent new-resource operations reserve estimated space; completion invalidates the inventory. Historical capture refreshes its admission status periodically without blocking physics.

New World Runs, World/Agents definition saves, and Room creation through REST, WebSocket, Module Capabilities and AI/MCP tools use the guard. Room creation has one async application entry point, above the synchronous Room directory. Restore bypasses new-resource admission. Existing messages, documents, journals and checkpoints are not pruned, and their continued authoritative writes are not hard-capped by this pass; a full filesystem quota or transactional write-admission system would be a separate change. Growth by other programs is also outside these application ceilings.

Observation logs additionally have a 512 MiB ceiling per configured directory, across current and older sessions, configurable with `LEITBILD_LOG_DIRECTORY_MAX_BYTES`. Current session rings still rotate; reaching the directory ceiling drops/reports new optional observations without deleting old sessions. It is not a quota across arbitrary user-selected directories.

Historian accounting includes database, WAL and shared-memory files. Budgets are checked at maintenance boundaries; an in-flight SQLite transaction or an external pinned reader can temporarily exceed the observed threshold. Capture then stops rather than claiming a hard physical cap. Corrupt/unopenable history is unavailable, not an empty dataset: its count is unknown, historical queries return a structured error, Run inspection and Agent context expose the reason, and current simulation remains usable.

Scenario previews ask Pack-owned estimators for initial series counts and show aggregate sample-limited retention in simulation seconds, independently of the observation-age ceiling in real days. Counts can change with assets/state, and actual value suppression can reduce traffic. Estimation does not start Pack runtimes. Historian sampling/deadband controls and downsampling remain the separate follow-on design; no such controls are claimed here.

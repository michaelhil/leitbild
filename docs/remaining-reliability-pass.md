# Remaining reliability pass

## Adversarial review

The reproduced failures are ownership gaps, not reasons for another runtime framework. Use a small operation scope: allow concurrent work, reject new work once closing begins, and drain accepted work before deletion. Keep Module state owners independent. Idle reclamation must check requests, definition work, loaded Runs and background execution; never evict merely because a browser is quiet.

History is optional, but a failure must not masquerade as an empty successful recording. Preserve the file, report unavailable capture/query state, close failed database handles, and continue canonical simulation. Do not swallow canonical-state failures or repair corrupt history automatically.

Storage controls must account for WAL and aggregate growth, avoid scanning directories on every simulation tick, and never delete authored content automatically. Refuse optional capture or new resource growth before consuming the final-save reserve. Report actual limits and clearly label sampling-rate estimates; do not promise seven days when the sample cap expires earlier.

The Halden grid is not a calibrated, balanced four-reactor operating point. Describe its stressed initial condition in the authored scenario. Do not manufacture demand, exports or line capacity to remove alarms.

## Implementation and verification

- [ ] Drain workspace/definition operations on deletion; cover World and Agents and late references with deterministic race tests.
- [ ] Reclaim inactive World containers under capacity pressure without closing active/background Runs; test concurrent admissions.
- [ ] Isolate historian startup failures, preserve damaged files, expose unavailability, and include WAL in storage accounting.
- [ ] Add a focused aggregate storage admission/log budget and expose retention/rate information, with bounded cost and explicit errors.
- [ ] Clarify Halden's authored starting conditions without changing physics or existing progressed Runs.
- [ ] Validate standalone and combined tests/builds, commit, push, deploy and verify production.

No backup setup, compatibility layer, generic event bus, new telemetry service, automatic authored-data deletion or historical-file compaction is included.

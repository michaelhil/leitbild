# Reliability and bounded storage implementation

Status: implemented and verified in production. Deployed code: `e9af450c`, release `20260902T220840Z-e9af450caa-0e52b4892e`. Source audit: 2 September 2026, `5f7d4ab2`.

Operator decision: no backups exist and the owner explicitly declined setup. No backup work is planned; potential permanent data loss remains accepted, not a deployment blocker.

## Delivery stages

- [x] Serialize Run and Workspace lifecycle; own pending startup resources; protect requests and autonomous work; bound idle caches.
- [x] Serialize Agents snapshots and final flush; quiesce producers before shutdown; publish one committed snapshot generation with a single retry budget.
- [x] Separate electrical provider availability from physical connection state; preserve connections through pauses; make terminal runtime health authoritative.
- [x] Balance the reference Plant's initial thermal, fluid and electrical operating point against the actual equations and support all configured loop counts without clamping output.
- [x] Bound historian capture and storage, expose honest query/truncation/retention metadata, and validate series semantics.
- [x] Bound Module requests and preserve errors; reject unsupported keyed retries; keep metadata discovery lazy and read Run context from pinned artifacts.
- [x] Permit incomplete local scenario edits while retaining strict Save/Start validation.
- [x] Audit other persistent growth, implement scoped safeguards, document the owner's no-backup decision and a possible future restore procedure.
- [x] Run regression, full-module, combined, production and UI verification; commit logical stages and deploy.

## Historian design

Detailed delivery boundary, measurements and follow-on stages: [Historian and storage management](./historian-and-storage.md). The Plant's model limits and changed combined-grid baseline are documented in [Reference PWR operating point](../apps/world/docs/pwr-operating-point.md).

Lifecycle limits: World admits at most 64 Workspace containers per registry and keeps at most 32 compiled revisions per container. It rejects excess admission instead of evicting a container whose definition queue a caller may still own. Agents retains its configurable 128-runtime limit and does not evict autonomous work to make room. World requests hold scoped leases; the discoverable Background Execution command keeps an unloaded-by-idle Run from disappearing, but is deliberately not an auto-restart scheduler or a command to resume its clock.

Keep one SQLite historian per Run, owned by World. A historian is optional observation history, not restart state, a second event journal, or an external database service. Keep the same typed sample/descriptor boundary usable by any Pack; a future Agents historian can adopt equivalent semantics without sharing a runtime.

1. **Capture intent:** a named Pack profile selects semantic signal groups. Visibility, writability and discovery must not implicitly select recording. Use per-component-type recording metadata for the Plant library, not per-instance lists. Keep engineering capture explicitly opt-in. Preview series count and maximum samples/time before launch.
2. **Efficient sampling:** sample on simulation cadence, record discrete changes, and support numeric deadband plus a maximum silence interval. Preserve first samples and quality changes. State exactly that retained samples are observations, not an exact replay trace.
3. **Retention:** age and sample-count limits bound retained history; a per-Run byte ceiling and deployment free-space guard provide independent safety. Defaults are operator policy, discoverable with effective values. Retention discards oldest observations only, never scenarios, current state or user documents. Report discarded counts and retained ranges. Age uses observation time so pause/speed changes cannot defeat retention.
4. **Queries:** explicit observation/simulation time axis; latest-by-default bounded pages; stable cursor/tie-breaker; truncation and retained-range metadata. Filters remain typed and indexed. Avoid returning every descriptor on every sample request. Status must not rescan millions of rows.
5. **Integrity:** bind a series to its subject, signal, type and unit. Reject semantic changes under the same identity and mismatched samples. Normalize timestamps centrally. Store compact numeric series references rather than repeating long identifiers in every sample.
6. **Maintenance:** prune in bounded batches; reuse free pages; bound WAL/checkpoint behavior; never VACUUM a large live database in a request. A storage limit must report capture degradation, not silently corrupt history or kill the simulation. Inactive Run maintenance must also be discoverable and bounded.
7. **Scale:** start with SQLite, compact indexes, bounded pages and capture reduction. Add rollups or an external store only when measured workloads require them; do not prebuild sharding, a query language, or a generic telemetry platform.

## Other disk consumers

Inventory Run journals/snapshots/private checkpoints, Agents messages/documents/attachments/traces, definition revisions, temporary atomic-write files, deployment releases/staging, map/reference/OSRM artifacts, service/container logs, local build artifacts and backups. Each category must have a named owner and either a bounded lifecycle, an explicit quota/rejection, or a documented operator-managed retention rule. Regenerable artifacts may be pruned by exact validated paths; never prune user-authored state merely because it is old. Backups need separate retention and restore validation, not an unlimited second copy of the same growth.

## Adversarial checks

- Limits on individual histories do not bound an unlimited number of Runs: include deployment capacity admission/visibility.
- Deleting SQLite rows does not guarantee immediate filesystem shrinkage: account for pages and WAL, not just row counts.
- Deadband can hide slow drift unless measured against the last recorded value and capped by a silence interval.
- Pagination must handle equal timestamps and retention between requests honestly.
- A successful cached query does not mean a failed solver recovered.
- Request cancellation does not prove a command never committed; do not automatically retry uncertain writes.
- A short request lease is not a background execution policy. Browser presence must not be the hidden authority for autonomous work.
- Per-owner operation queues must not become one global cross-Module lock.
- Plant equilibrium must emerge from consistent parameters and equations, not hard-coded power restoration.

No compatibility aliases, hidden fallback formats, universal Pack engine, blanket recording, or automatic deletion of user-authored content.

## Verification

Full predeployment checks and builds passed. Automated suites: 18 Contracts, 7 Module Runtime, 1,425 Agents (2 optional soak cases skipped), 610 World, 19 Host (including command deadline semantics), and 1 full-platform integration test: 2,080 passed. Both dry run and production deployment completed. [CI for the deployed code](https://github.com/michaelhil/leitbild/actions/runs/33688760362) passed.

Production: Host, World, Agents, Caddy, OSRM and public HTTPS health passed; all three application services reported zero restart loops. Browser verification covered the current Workspace catalog, rendered editor map and applying one valid cue while another remained incomplete. No browser errors were reported; the local test draft was closed without saving. No production Run was reset and no user data was deleted by this work. Existing large browser chunks still produce advisory build warnings; no new framework or bundling workaround is part of this reliability pass.

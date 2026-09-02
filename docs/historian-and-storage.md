# Historian and storage management

## Decision and delivery boundary

Keep one optional SQLite historian per World Run. It stores observations, not authoritative state, a replay journal, or authored content. Retention may discard observations; it must never delete scenarios, messages, procedures, or restart checkpoints. Agents should eventually contribute equivalent typed observations through its own owner, not import the World runtime.

This reliability pass adds bounded recent history, explicit capture degradation, descriptor/value validation, latest-first cursor queries, observation/simulation-time filters, and capture selection independent of discoverability. The richer authoring controls and compact physical layout below are a follow-on design, not functionality claimed to exist today.

## Capture: small, explicit, discoverable

Keep the existing Pack/profile/interval choice. A profile describes semantic groups, not thousands of instance paths. Plant Operations selects state, controls, discrete state, tagged instrumentation and power balances. Engineering includes all variables. Publishing a new variable no longer implicitly records it. Unchanged Plant values emit a minute heartbeat measured in simulation time; changes emit on the configured sampling cadence. This is sampled observation, not lossless event capture.

Next, expose each profile's group descriptions, resolved series count, maximum sample rate and effective retention in preview and inspection. Add only three optional numeric controls: sampling interval, absolute deadband in the descriptor's unit, and maximum silence interval. Compare against the **last retained value**, not the last sampled value, so slow drift is not lost. Always retain first observations, discrete changes and quality changes. Reset the sampling baseline if simulation time moves backwards. Missing data must be marked as a gap, never invented as a constant value.

Group defaults belong to component definitions/Pack profiles and can be changed once for every instance. Allow explicit per-signal overrides only when justified; do not introduce inheritance, selectors expressed as code, or a logging DSL. Observation metadata should include unit, quantity, subject, signal, quality and provenance. Changing subject/type/unit under an existing series id is an error.

## Capacity and retention

Initial safety defaults per Run: 250,000 samples, seven observation-days, 256 MiB database budget and 1 GiB free-space reserve. These are conservative sandbox guardrails, not benchmark-derived optimal settings. SQLite WAL has a separate 4 MiB reuse target and frequent checkpoints. A bounded maintenance pass removes at most 10,000 observations. Capturing under a storage failure is disabled and reported; physics and current-state persistence remain independent. Status exposes effective limits, retained observation range and discarded samples since opening.

Retention ends at the first applicable limit, not necessarily at seven days. The current four-loop Plant selects 454 Operations series versus the previous 565 published variables. Four Plants have a worst-case 1,816 samples/second at the default interval: 250,000 samples would then cover about 138 seconds, before Grid/Weather observations. Unchanged-value suppression reduces actual traffic, but is not a guarantee of a longer window. This is a bounded safety baseline, not the final historian capacity target; group/cadence/deadband controls and measured byte/rate estimates must precede claiming long retention.

Deleting rows reuses pages; it does not shrink an existing multi-gigabyte file. Oversized existing histories become read-only for capture under the byte guard and remain queryable. No live full VACUUM, implicit history reset or compatibility database is introduced. Reclaim physical bytes only through a deliberate offline compact/delete operation on an exact Run, with sufficient temporary disk headroom. Existing inactive histories are not automatically opened or deleted during deployment.

Next, make these limits a validated operator policy with optional tighter Run limits, never looser than the deployment ceiling. Add Workspace and deployment admission budgets: a per-Run cap cannot bound an unlimited number of Runs. Refuse new Runs/uploads/recording expansions before the free-space reserve is consumed. Account separately for database bytes, reusable pages, WAL, canonical state and authored content. Preserve a reserve for final saves; low-disk handling must not rely on creating a huge new file.

Age is observation time, independent of simulation speed, pauses and resets. Maintenance of inactive Runs should be an explicit bounded operator command with a dry-run report, not an unbounded timer inside every Workspace. An operator can choose a longer retention policy or export a particular run for research; export has its own quota.

## Query and layout

Current queries return newest recorded observations first, bounded to 2,000 by default and 10,000 maximum. Sequence is the stable tie-breaker/cursor even when timestamps coincide or simulation time resets. `timeAxis` chooses which time is filtered, not replay ordering. Responses expose `hasMore`, `nextBeforeSequence`, the earliest retained sequence and a retention-gap flag. Retention can invalidate an old cursor; clients must display that honestly.

Status uses cached counts and indexed endpoints instead of rescanning the history on every request. The one count on store opening is bounded for new stores; existing large stores still have a one-time opening cost. Series discovery is separate from samples in the direct API. The generic history Capability currently includes both; split descriptor discovery from paging when a real consumer needs repeated large queries.

Next physical-layout change: numeric series keys, numeric UTC timestamps, a compact typed value row, and only measured-useful indexes. Use one fresh documented format, not parallel compatibility readers or a migration framework. Add descriptor pagination and SQL plans for subject/signal windows before increasing the series ceiling (currently 20,000). Add aggregate/downsample queries only for a visualization that needs them; do not create rollups, sharding, a generic SQL endpoint or an external telemetry service preemptively.

## Other disk growth: measured 2 September 2026

Read-only host inspection: 75 GB disk, about 36 GB used and 37 GB available; World state 4.2 GB, including one 2.5 GB historian; map assets 9.2 GB; routing artifacts 3.1 GB; reference assets 247 MB; dependencies 519 MB; releases 20 MB; system journal about 307 MB. These measurements are not permanent capacities.

| Owner/data | Growth mechanism | Required policy |
| --- | --- | --- |
| World history | Signal count × sampling rate × time; WAL; inactive Runs | Capture reduction, bounded retention and quotas; deliberate offline compaction |
| World Run state/journals | Long-lived Runs, frequent canonical events, repeated checkpoints | Keep current checkpoint; bounded journal segments only after replay requirements are explicit; admission/free-space guard, never silent loss of accepted commands |
| World/Agents definitions | Every saved immutable revision | Keep revisions pinned by Resources; report/reject quota excess; explicit unreferenced-revision cleanup, not age-based deletion of authored work |
| Agents Rooms/documents/attachments/vectors | Messages, generated documents, uploaded blobs, embeddings | Workspace admission quotas and size limits, usage reporting, explicit deletion/export; no automatic loss of conversation history |
| Agents observation logs | Two-file ring **per session**, but unlimited new session ids; oversized flush batches | Bound each write and serialize rotation; add aggregate directory/session budget with explicit retention policy |
| Atomic writes | Failed writes leave random temporary files | `finally` cleanup for each owned temporary path; crash leftovers through scoped maintenance |
| Map generation | Full source, build scratch, release copies, partial downloads | One build lock; free-space preflight; atomic symlink promotion; keep current only plus an explicitly chosen recovery release; remove scratch after successful publication |
| OSRM | Source PBF duplicates map source; preprocessing generations | Reuse verified immutable source when same version; keep only active dataset plus explicitly selected rebuild inputs; never delete files mounted by the running container |
| Reference assets | Rebuild generations | Existing prune workflow; protect current and in-progress publication |
| App releases/dependencies | Deploy staging and old dependency generations | Existing successful-deploy cleanup; trap cleanup on failure; inspect orphaned failed staging separately |
| Journald/container logs | Persistent service errors or request volume | Explicit byte/age rotation on the host; rate-limit repeated identical application warnings |
| Backups | Repeated copies of growing histories | Exclude optional history by policy or cap it separately; bounded backup generations; encrypted off-host destination and restore drill |

No blanket filesystem cleanup is safe: these categories have different owners and recovery semantics. The current deployment already removes superseded code/dependency releases; it does not publish or prune maps, routing artifacts or live user data.

Implemented in this pass: the Agents observation sink now bounds both queued bytes and individual file writes, serializes flush/rotation/close, rejects oversized records and reports loss. World atomic publication shares one temporary-file cleanup helper; Agents marker publication also cleans up failed temporary writes. Map promotion validates the release and atomically replaces only the current symlink, without recursive removal or a missing-current interval. No existing production map, history, message or authored file was removed.

Follow-on order: (1) expose effective capture/retention and series/rate estimates in the editor; (2) add validated operator ceilings, tighter optional Run policies, deadband and maximum-silence controls; (3) add aggregate Workspace/deployment admission and an explicit dry-run maintenance report covering all owners above; (4) change physical history layout and add downsampling only after measured workloads justify it. Directory/session log budgets and canonical journal/revision retention remain in step 3, not silently implemented as age-based deletion.

## Backup and restore

The owner confirmed on 2 September 2026 that there is no backup and explicitly declined backup setup. No backup infrastructure is part of this work. Hardware loss, corruption or accidental deletion can therefore cause permanent data loss; code releases and retention safeguards do not provide recovery. This is an accepted operator decision, not a deployment blocker. The policy and restore drill below apply only if that decision changes.

Recommended starting policy: nightly consistent snapshots of Host, World and Agents state, seven daily and four weekly generations, with optional historian excluded or capped. Capture map/reference/routing artifact identifiers and environment/service configuration separately; handle secrets through the backup system, never Git. Use SQLite's backup API for live databases, or quiesce all three services for a coordinated filesystem snapshot. Do not copy an open SQLite main file without its transactional context.

Restore drill: restore into a new isolated directory and private ports; validate SQLite integrity and strict state documents; provision no new identities; open a saved Run, verify its pinned compiled artifact/checkpoint/procedure state and a Room's messages/profiles; test one command and a second restart; then compare resource counts and byte usage. Record the tested backup id and recovery time. Only after explicit approval should restored state replace production. Keep the original state untouched until validation is complete.

## Adversarial acceptance tests

Test fixed/slow/fast/paused/reset clocks; unchanged signals, slow drift, quality changes and removed assets; type/unit conflicts; identical timestamps across pagination; retention during paging; store reopen, interrupted transaction, full disk and WAL growth; many small Runs, not only one large Run; oversized log records and concurrent flush/close; failed rebuild/promotion; and actual isolated restore. Sample-count caps are not byte caps; file caps are not directory caps; a successful health endpoint is not proof that capture, saving or backups work.

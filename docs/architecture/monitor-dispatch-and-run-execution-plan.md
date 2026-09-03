# Situation Monitor, Ambulance and accelerated Runs

Date: 3 September 2026. Audited baseline: `1e9ace11`.

Status: investigation and adversarial review complete. The isolated Situation Monitor correctness fixes are implemented and deployed. The Ambulance replacement and shared Run-execution changes below are a coordinated proposal, not already implemented functionality.

## Recommendation

Keep the current Module and Pack boundaries. Situation Monitor needs targeted hardening, Ambulance needs an operational-model replacement, and reliable acceleration needs one World-owned execution/checkpoint boundary. These are different levels of change, not three independent rewrites.

Prioritize a dispatch-oriented demonstration for the doctor's first meeting in a few weeks. Include patient disposition and hospital handover as useful discussion topics. Do not build clinical physiology, staff rostering, a full emergency department, or a fleet optimizer before that conversation.

The most valuable simplifications are:

- Explicit operational state instead of invented medical detail and hidden demo timers.
- An incident **at** an existing asset, not a new asset hierarchy or conversion of the asset into an incident.
- One advancement mechanism for normal and accelerated execution, not separate fast-mode implementations in each Pack.
- One coherent current-state checkpoint used for both restart and branching.
- Existing Scenario, Capability and Agent-broker mechanisms, not a new orchestration framework.

## 1. Verified baseline

Parallel read-only audits covered Situation Monitor, Ambulance/domain research, and Run execution. Shared-core and Agent interfaces were reviewed centrally. Before fixes, all 26 Situation Monitor tests and all 20 selected Ambulance/Weather tests passed. Several Ambulance tests actually protect the unwanted demonstration behavior; passing them is not evidence of domain correctness.

### Situation Monitor

The basic topology is appropriate: reviewed provider adapters, dynamic provider catalogues, one bounded Workspace snapshot cache, Run-owned source configuration, typed queries, native map layers, lazy media, and the existing Agent capability broker.

Reproduced or directly traced issues:

| Issue | Evidence under `apps/world/src/packs/situation-monitor` | Correction |
| --- | --- | --- |
| A faster source lease can retain the previous one-day poll deadline | `ingestion/collector.ts`; 86,400-second source followed by a matching 60-second source still had roughly 86,402 seconds until polling | Separate provider/backoff restrictions from locally calculated polling cadence; reschedule on lease changes |
| Shared records retain the first subscriber's custom attribution and MET subject label | `adapters/decode.ts`, `runtime.ts`; equal collection keys with different local names reproduced leakage | Cache provider provenance only; decorate with current Run-local presentation metadata on reads |
| Any inspection failure is treated as deletion | `ui/MonitorPanel.svelte` | Explicit not-retained result; retain selected evidence and show refresh failure for transient errors |
| Empty multi-geometries and inverted latitude bounds pass some validators | `model.ts`, geometry bounds calculation | One validated bounds schema; reject empty multi-geometries |
| Norwegian geometry is parsed twice | `adapters/decode.ts` | Delegate to the provider decoder before generic normalization |
| Search returns heavy full records without useful modality/validity filters | `capabilities.ts`, `ingestion/store.ts` | Compact summaries and a few typed filters; keep full inspection separate |
| Retained expired warnings can appear as current map evidence | `map.ts`, `ingestion/store.ts` | Distinguish active, scheduled, expired, unknown and stale evidence; preserve original timestamps |
| Catalogue discovery followed immediately by source preview hits a shared one-minute gate | `runtime.ts` | Reuse bounded network admission and a small preview cache/limit; do not remove upstream protections |

Keep the previously fixed persistent retry handling, atomic complete snapshots, empty-feed identity, stable media IDs, forecast selection, icon admission, media selection, and visible coverage limits. Do not reopen already-resolved findings as new work.

### Ambulance

Evidence under `apps/world/src/packs/ambulance`:

- `sim/engine.ts` reveals every unknown incident after five elapsed seconds and degrades every hospital after ten seconds. `sim/object-state.ts` supplies exactly two casualties, fixed injuries/hazards, arbitrary confidence, and fixed vital signs. These are hidden behavioral assumptions, not scenario-authored rules.
- Hospital defaults imply trauma, stroke and catheterization services; vehicle defaults imply clinical capability. These should be explicitly configured, not inferred from a label.
- `sim/interactions.ts` transfers aggregate patient counts immediately upon arrival. There are no patient identities, scene service stages, proper handover queues, or reliable release from a full receiving site.
- `assign-to-incident` accepts a hospital target. Deleting a destination can leave a vehicle canonically assigned with a dangling target and route. Both were reproduced.
- Initial ETA uses route-service duration, but movement uses a fixed 15 m/s. Restoring movement guesses the nearest route vertex and loses exact motion state.
- Foreign Pack objects are filtered out of the runtime's initial and committed views. The unused medical-demand handler ignores `sourceObjectId` and creates another point incident.
- Commands republish whole-fleet snapshots as durable events; several queries repeatedly scan/parse the fleet. Scenario construction and live creation use inconsistent constructors.
- Agent discovery exposes mainly full objects, not an operational dispatch board or eligible choices with rejection reasons. The ordinary companion's grants omit useful Ambulance-specific reads.

Preserve the Pack boundary, routing port, typed road-weather constraint, canonical projections, Scenario integration, recording and Capability registry. Replace the domain engine and its tests, not the surrounding product architecture.

### Execution and branching

Evidence under `apps/world/src`:

- `core/model/time.ts` computes simulation time as elapsed monotonic wall time multiplied by speed. The Pack protocol has `setClock`, but no common completed-advance or checkpoint barrier.
- Plant, Grid, Weather, Ambulance and Drone adapters own separate wall timers. At high speed they process large elapsed intervals rather than simply executing the same small steps faster.
- Plant ramps/protection run around a catch-up batch, not every equivalent control interval. Grid dynamics integrate large variable intervals. Timeline actions have another scheduler. This can alter outcomes and event ordering.
- Snapshot and private runtime state files are saved independently. A directory copy can contain different simulation epochs.
- Drone private home, mission/hold and geofence state is not fully persisted. Ambulance route progress is reconstructed approximately. These are restart issues even without branching.
- Recording can skip scheduled boundaries during large catches. Publication is fire-and-forget in places; unbounded fast execution could accumulate commits or socket output.
- OSRM routing has a bare fetch without cancellation/deadline. A serialized command waiting for it could prevent a fork or shutdown fence from completing.

The existing Run leases, runtime Hub, command routing, projections, historian and resource URLs remain useful. No external job system is needed.

## 2. Domain direction for Ambulance

### What the research supports

Norwegian response-time measurement runs from AMK notification to the first ambulance's arrival at the scene; it is not just driving time, and scene arrival is not necessarily patient contact. Report those milestones separately, along with denominator and incomplete incidents. Published response targets are guidance, not a simulated guarantee. [Helsedirektoratet indicator](https://www.helsedirektoratet.no/statistikk/kvalitetsindikatorer/akuttmedisinske-tjenester-utenfor-sykehus/median-tid-fra-amk-varsles-til-ambulanse-er-pa-hendelsessted-kommune)

Sykehuset Østfold describes dispatch/resource management by AMK Oslo and coordination with receiving specialties. Certain cardiac destinations depend on clinician/ECG assessment. Therefore nearest hospital with a spare generic bed is not an adequate universal destination policy. [Sykehuset Østfold ambulance service](https://www.sykehuset-ostfold.no/avdelinger/klinikk-for-kirurgi/prehospital-avdeling2/ambulanse/)

Model operational times and capacity effects, not invented survival or treatment efficacy. FHI's analysis explains the difficulty of isolating response-time effects from other factors. [FHI report](https://www.fhi.no/en/publ/2023/Ambulance-response-time-and-patients-outcome/)

The 2026 Norwegian mass-casualty guidance is currently a consultation draft with an October deadline. Do not encode it as final clinical policy. The initial demo can discuss staging/receiving decisions with explicit authored suitability without claiming to implement a validated triage algorithm. [Helsedirektoratet draft](https://www.helsedirektoratet.no/veiledere/masseskadetriage-horingsutkast)

### Four concepts, not a universal rescue framework

| Concept | Authoritative state | Deliberately not included initially |
| --- | --- | --- |
| Response unit | Vehicle/care/equipment capability, patient capacity, crew readiness, base, current assignment and phase | Independent crew roster, shifts, labor optimization |
| Incident | Reported problem, dispatch urgency, occurrence location, linked asset if any, reported/assessed demand, milestones | Fabricated physiology, automatic global revelation |
| Patient | Stable ID, incident, assessed needs/priority, disposition, current holder | Detailed organ models or unsupported survival scores |
| Care site | Receiving/stabilization role, location, accepted needs, handover slots, queue and service duration | Complete hospital bed-flow simulation |

Dispatch urgency and assessed clinical priority are separate concepts. A building is not a care service merely because it has a position or hospital-like name. Capacity, queue length and carried counts are derived from patient/assignment state, not separately maintained competing counters.

Keep configured service durations deterministic at first and visibly labelled as assumptions. Add seeded distributions only with a concrete experimental purpose. Do not wrap fixed equipment specifications in uncertainty/confidence objects.

### Location without a new attachment hierarchy

Creation accepts either a map point or one reference to an existing positioned Operational Object. Resolve the latter once and capture the point as the incident's occurrence or care site's established location. Retain `subjectObjectId` for provenance and co-located presentation.

This is deliberately a fixed location, not an automatic attachment to a moving object. If a bus moves after an incident is reported, the incident remains where it occurred. If a plant is deleted, its incident and patients still exist at the captured location. Explicit relocation can be a later domain operation; do not implement implicit follow/fallback semantics now.

The existing Scenario compiler already expands items from a global dependency-aware queue using each Pack's declared `referencedObjects`. Extend that contribution and reuse final `validateInitialObjects`; no new compilation pass or generic reference graph is needed. Live creation uses the same validator/constructor with a read-only canonical object lookup. It never imports or mutates another Pack's private implementation.

Patient location is a separate Ambulance-domain relationship: held at an incident, in a response unit, or at a care site. Derive its location from that holder. Do not write a new patient position event on every vehicle motion tick. Validate that each patient has exactly one holder and cannot board two units. Reject deleting a holder with patients until an explicit transfer/disposition is committed; deleting a provenance-only subject such as the originating plant is a different operation.

On the map, an incident linked to a still co-located asset may badge/highlight that asset and appear in its related-incident list. Keep an independently discoverable incident identity. If the asset moves/disappears, render the incident at its captured point; do not hide the event.

### Lifecycle and routing

Use an explicit assignment lifecycle:

`allocated → mobilizing → responding → on-scene → transporting → queued/handover → available`

Not every assignment transports a patient. No-transport, cancellation, reassignment and completion are explicit outcomes. Multiple units can serve one incident. Cancellation cannot make a patient-carrying unit empty or available by fiat.

Separate ambulance-facing handover slots from general hospital beds. Start with a deterministic queue/service rule, expose it in configuration, and record queue entry, handover start, patient transfer and unit release. Do not make full destinations permanently strand vehicles without a recovery path.

Use route duration consistently for both movement and ETA. The minimum useful model distributes the returned total duration over route distance and labels this assumption; per-segment times can improve it where the routing response provides them. Neither is a calibrated emergency-driving model. Explicit weather/response modifiers must affect ETA and progression consistently.

Routes are prepared outside numerical stepping, bounded by timeout/cancellation, persisted with assignment state and guarded against late stale results. Restore exact route cursor, phase deadline and patient ownership. Advancing across several phase boundaries must process every transition and use the remaining elapsed time correctly.

Emit only changed domain objects and meaningful events. Build small indexed maps for assignment/patient lookup where the engine already owns these identities; avoid a separate indexing service.

### Doctor demonstration

Create one editable **Halden–Aremark: competing calls and coverage** Scenario:

1. A small synthetic response roster on real regional geography, with explicit capability and service-time assumptions.
2. A rural call commits a nearby unit; a subsequent acute call creates a dispatch/coverage decision.
3. An incident at an existing industrial asset introduces a few individually tracked patients.
4. Kalnes is a receiving destination; a configured temporary municipal care site illustrates suitable staging without pretending every patient belongs there.
5. A handover bottleneck delays unit release and affects the next call. Optional authored Weather adds a visible travel constraint.

Make the initial explanation work in roughly ten minutes. Avoid requiring four nuclear solvers, every source feed and a Drone mission just to demonstrate dispatch. A separate mixed-Pack acceptance Run can exercise the full integration.

Show call-to-allocation, mobilization, travel, first arrival, scene time, transport, queue/handover, unit utilization and outstanding demand. For a handful of demonstration calls, individual timelines and completed/pending counts are more useful than impressive-looking percentiles. Candidate units/destinations should explain eligibility and rejection, not invent a composite optimization score. If only geometric distance is available, do not label it ETA. Do not label synthetic assumptions as the real fleet, current hospital capacity, validated emergency travel times or patient outcomes.

Use the first meeting to validate terminology, decisions and plausible parameter ranges. A credible operational demonstration is not yet a calibrated research instrument.

## 3. Situation Monitor follow-through

Apply the isolated cache, polling, validation and inspection fixes first. Then improve the existing interfaces rather than adding another layer:

- Search summaries: IDs, concise title, provenance/times, subject/location summary, modality and validity. Full geometry/details remain in inspection and map queries.
- Add kind/category/severity/media-format/active-at filters. No arbitrary query language or per-provider Agent tools.
- Show active/scheduled/expired/unknown separately from collection freshness. A fresh poll does not prove an old camera image is fresh; no active warning does not prove safety.
- Keep a selected record during a transient refresh failure. Clear only when explicitly confirmed no longer retained.
- Consolidate discovery/preview admission without bypassing provider limits. Provider adapters remain reviewed code; their discovered station/camera identities remain data.
- Keep national-map coverage honest. Clustering a capped subset must not imply complete national counts.

Do not add new providers, arbitrary crawling, auto-installed connectors, per-record LLM enrichment, raw media archives or another database during this hardening pass.

## 4. One execution path for ordinary and accelerated Runs

### Owner and stepping contract

World's Run executor owns completed simulation time. Wall time determines pacing, not scientific state. Normal execution waits between advances; accelerated execution performs the same bounded advances as quickly as resources allow and yields regularly.

The minimal runtime addition is a three-phase boundary plus export of complete opaque private checkpoint state:

1. **Prepare:** capture necessary peer-query inputs from the committed state at `t`, without mutating mechanics.
2. **Advance:** execute bounded mechanics from `t` to `t + delta` using those inputs; no peer queries or network calls in this phase.
3. **Commit:** collect outputs, settle bounded immediate consequences in stable order, then expose the new completed clock and state.

Preparation data is a transient Pack-owned value, not a persisted new configuration format. The Hub can enforce query availability by phase, reusing the existing typed query port. Merely calling `advanceTo` sequentially or with `Promise.all` would still let Ambulance observe old or new private Weather state depending on execution order.

Runtime-specific numerical solvers retain their own internal substeps. Declare the maximum safe communication interval without designing a universal Pack scheduler. An initial 100 ms communication interval matches the current PWR internal step; validate it against 50/25 ms coupled tests rather than declaring it scientifically sufficient by fiat. Native Drone keeps its finer internal integration; Weather retains its own ground-step remainder. The scheduler never branches on Pack names.

Clip work at the requested target, scheduled Scenario cue, control/recording boundary and runtime safe limit. Plant ramps/protection and Grid dynamics must have pacing-independent simulation-time cadence. Timeline cues cannot execute after physics has already passed their scheduled time.

Cross-Pack round inputs must be coherent. Plant and Grid advance from previous-boundary electrical inputs; existing Grid zero-time balance/projection updates then settle changed Plant output, and Plant queues the resulting network input for its next numerical step. Preserve this finite boundary exchange; do not add a Plant-first rule or repeatedly integrate physics until it appears stable. A bounded consequence queue detects programming loops, not numerical convergence.

Coalesce Ambulance road-weather sampling to relevant advancement/command boundaries. Currently unrelated foreign object updates can repeatedly trigger it. Reuse unchanged prepared inputs where their location/provider revision/policy has not changed, without querying future private state.

The Hub awaits emissions and interaction processing before publishing completed time. Read queries see a completed boundary, not half-updated coupled state. A partially failed advance is **fail-stop**, not an ordinary resumable pause: block private queries, further advancement and forks until recovery from the last coherent checkpoint. Per-step rollback would require staging/copying all mechanics; do not promise that without implementing it. Preserve inspectable last-committed state and report any loss of uncheckpointed progress explicitly.

### Checkpoint and fork

At a short supported mutation fence, complete the current boundary, drain accepted work, export the canonical state plus each runtime's opaque private state, and create a new ordinary Run. Preserve the original's prior pacing/paused state. Detach the in-memory capture before releasing the fence; disk serialization can then proceed without holding the source Run stopped.

Do not wait indefinitely on external routing. A fork with an unresolved mutating command reports busy promptly; it must not copy a half-applied command or cancel the user's original action. Provider cancellation plus stale-result guards are required; `Promise.race` alone does not stop a late mutation. A scheduled dispatch may hold progress at its exact cue time while a bounded route request completes; show a waiting reason. This is more honest than claiming routing is instantaneous or silently skipping the action, although it reduces achievable throughput.

The coherent checkpoint includes compiled Scenario/revision and connections, all current additions/deletions, runtime configuration, clock, fired/pending timeline state, procedure ticks/current steps, pending internal writes, solver remainder, ramps/protection, Grid energy/frequency, Weather remainder, exact route state, Drone home/mission/hold/geofences, recording configuration/cursors and fork provenance. Runtime checkpoint data must not duplicate cached canonical projections. Initialize restored Grid load profiles at the checkpoint clock, not the Scenario's original start. Derive recording cursors from the fixed simulation epoch or persist them exactly. New execution health counters/viewer leases are not cloned physical state.

Reuse this format for restart. Do not retain independently authoritative snapshot/private-state formats plus a third branch-only format. An atomic file rename alone does not make the checkpoint and semantic journal transactional: the current journal can advance beyond the separately saved snapshot.

For the coordinated rewrite, prefer **one Run SQLite transaction for current checkpoint plus semantic journal**, using the existing Bun SQLite dependency. One opaque checkpoint envelope and ordered event rows replace split JSON snapshot/runtime writers; no ORM, per-Pack table registry or new service. The alternative is a custom JSON commit-watermark/fsync/recovery-tail protocol, which is more specialized recovery code to maintain. Keep the historian's existing optional-failure policy separate and visibly report capture gaps; do not imply it joins this transaction automatically.

Measure checkpoint size and write cost. Do not serialize every object and private value after every 100 ms physics step. Persist at explicit durable command boundaries, periodic wall-time checkpoints, fork, pause, target completion and shutdown. Include bounded completed command-idempotency results in durable command commits; do not copy parent request IDs into a new fork. Distinguish completed in-memory progress from last durable checkpoint time. A new Run is not listed as ready until its complete state is durable; storage admission and interrupted creation cleanup remain mandatory.

Keep object IDs, since they are Run-scoped; allocate a new Run identity and independent future event sequence. Record source Run, source sequence and fork simulation time.

A complete **current-state** copy does not require duplicating the full historian or chat transcript. Begin a new journal at the fork; retain explicit ancestry. Pre-fork history is not independently preserved if its source is deleted unless a separate retention rule is implemented. Say this in the UI rather than promising an archival clone.

### External evidence and controllers

An accelerated experiment captures Situation Monitor's bounded retained normalized evidence window into a Pack-owned immutable artifact referenced by its checkpoint. Capture only its active sources once; do not reserialize megabytes of unchanged evidence in every physics checkpoint. The fork does not subscribe to later shared-cache replacements. Preserve capture, retrieval and validity timestamps; this is evidence available at the fork, not a forecast generated for the future simulation time. Artifact lifecycle belongs to that Run and is removed with it, subject to existing storage safeguards.

Media URLs remain external links, not cloned recordings. Clearly label any opened live video as outside the experiment's captured state. If the evidence capture exceeds storage limits, fail explicitly rather than silently fall back to live collection.

Human input leases, live hardware and ongoing Agent/LLM jobs are not accelerated physics. Do not clone pilot ownership, retarget the original Room's jobs, multiply provider polling, or silently omit a runtime. Preflight exposes unsupported states. Agents can discover and observe the new Run normally and deliberately act on it; external inputs make subsequent comparisons input-dependent.

Agent-in-the-loop experiments would need explicit decision points that wait for real inference. That is a later policy, not a claim of the initial maximum-speed mode. No paid inference is needed to benchmark the physical model.

### Job state, UI and performance

Acceleration is small server-owned state on an ordinary Run: start/target/completed simulation time, active compute wall duration, running/paused/completed/failed status and an error if any. Reuse a Run background lease. Closing the browser need not stop the requested calculation; pause, completion, deletion or failure releases the lease. Restore interrupted work paused after a service restart.

The stopwatch opens a modal with horizon minutes, source time, copy name, external-evidence policy and preflight issues. **Create accelerated copy** opens the new Run through its ordinary URL. Provide an explicit new-tab link rather than relying on a delayed popup. Further acceleration continues the same copy; it does not create another fork each time.

Keep an always-visible progress indicator with completed simulation time, horizon, compute wall duration, measured speed and Pause. At the horizon, pause exactly; offer normal-time continuation and another duration. Validate finite positive horizons and enforce existing resource/storage limits. Duplicate start commands must not spawn duplicate loops.

Yield after bounded wall-time slices and check pause between steps. Start with one accelerating Run admitted at a time; a second request gets a clear busy result, not a hidden queue service. Coalesce latest-value UI updates in wall time, but preserve semantic events and requested historian sample cadence in simulation time. Slow sockets require bounded buffers/resynchronization, not unbounded accumulation.

Local real PWR benchmark, Apple M2/Bun 1.4.0, 300 simulated seconds, warmed median of three: one unit took 741 ms (~405×); six took 4.29 s (~70×). This excludes Hub, Grid, Weather, persistence, browser, Agent work and optional protection runners. It supports feasibility, **not** a promise that a complete Run executes at 200× or an hour finishes in under a minute.

## 5. Agent integration

Keep `workspace_catalog`, `workspace_capabilities` and `workspace_invoke`. Add bounded domain read models and precise operation schemas, not hardwired resource IDs or a new Agent framework.

- Ambulance: dispatch overview, incident/patient detail, eligible units/destinations with reasons, operational milestones/metrics; strict assignment/reassignment/transport/disposition commands.
- Monitor: modality/validity/source-filtered summaries, full inspection, explicit live-versus-captured metadata and collection failures.
- Run: committed simulation time/sequence, branch ancestry, progress, preflight constraints, pause/resume and future fork operations through the existing registry.
- Grant appropriate domain reads to the ordinary companion; management and dispatch writes remain deliberate. No provider credential or secret enters prompts.
- Use the same constructor/validator and operation for editor, Timeline, UI and AI. Keep future Scenario cues private; do not claim a blind dispatch experiment if a generic raw-object query reveals its hidden state.

Review exact-capability discovery for optionally returning output schemas; currently the Agent broker strips them even for a precise capability lookup. Avoid dumping every input/output schema into every turn. Measure payloads before redesigning catalog pagination.

External reports are evidence, not commands. No news item silently causes a Plant fault, an Ambulance dispatch or a Weather change. Such effects need an explicit authored operation or authorized Agent decision with provenance.

## 6. Implementation order and acceptance gates

| Phase | Work | Gate |
| --- | --- | --- |
| A — isolated correctness | Monitor cadence/provenance/validation/inspection fixes; focused regressions | Existing and new tests, type/build checks, production source/UI smoke; no cache/history deletion |
| B — execution seam | Awaited bounded advances, committed clock, routing cancellation, coherent checkpoint; repair missing private state | Restart completeness, stable Plant/Grid and Weather/Ambulance round semantics, no unbounded command fence |
| C — Ambulance replacement | Four concepts, shared constructors, fixed occurrence references, exact routes, assignment/patient/handover invariants | Patient conservation, wrong-target rejection, simultaneous commands, deletion/reassignment, interrupted stages, route failure |
| D — usable demo and discovery | Editor controls, domain read models, companion grants, one Norway dispatch Scenario; Monitor compact queries/validity | All editor/Timeline/AI actions use identical validation; coherent ten-minute demo; bounded payloads |
| E — branching and acceleration | Complete fork, captured evidence, server-owned horizon state, UI, bounded publication | Original unchanged, exact horizon, responsive pause, restart paused, frozen feeds, resource admission, normal/fast equivalence |
| F — integrated release | Mixed Plant/Grid/Weather/Ambulance run, Drone checkpoint tests, multi-user inspection, deployment | Whole-Run benchmark, historian cadence, slow-client and failure tests, production smoke |

Monitor changes and Ambulance domain work can proceed independently once their interfaces are agreed. Centralize changes to `simulation/protocol.ts`, Hub, Run runtime/registry, clock, Timeline and checkpoint persistence. Do not let three agents independently invent different stepping/fork interfaces or deploy overlapping partial releases.

This is a breaking execution/storage change, not a migration project. Scenario Definitions remain the authoring source; changed Ambulance examples are rebuilt with the new schema. Inventory affected existing Runs before cutover and report which need restarting. Do not silently parse old checkpoints as new state, retain a second legacy runner, or delete unrelated Workspace data. The shared executor is released only after every installed simulation adapter conforms; the stopwatch must not advertise partial Pack support as a complete copy.

Required regression matrix:

- Monitor: shorter/longer subscriber interval; release/reacquire/restart; provider Retry-After; equal cache key with different local labels/attribution; malformed geometry; transient inspection failure versus actual removal.
- Ambulance: double allocation; wrong target; full/incompatible destination; multiple units/patients; cancellation with passengers; no transport; target deletion; queue order/release; unresolved route; exact mid-route and mid-handover restore; all crossed service boundaries processed.
- Fork: mid-ramp Plant, Grid storage/frequency, fractional Weather advance, Drone home/mission hold/geofence, procedures/ticks, fired Timeline cues, removed objects and altered configuration. No original mutation or implicit Room-job retargeting.
- Execution: identical initial state and scripted inputs produce equivalent state/events at normal and maximum-speed pacing under the same step policy. Compare wall-time metadata separately; don't demand identical observation timestamps. Check timestep convergence for physical coupling as a distinct test.
- Performance: full mixed Run at one and multiple viewers; pause latency, API responsiveness, socket buffer/memory bounds, disk admission and historian sample cadence. Never trade away physical transitions to make a benchmark look faster.

## 7. Adversarial conclusions

| Tempting approach | Why not | Leaner choice |
| --- | --- | --- |
| Generic Place/attachment graph | Adds moving-anchor, cycles, deletion and persistence semantics before needed | Capture an occurrence point once; keep a subject link |
| Convert plant/building into incident/hospital | Violates ownership and conflates asset with an event/service | Independent incident/care-site identity at a referenced location |
| Detailed invented vitals/clinical scores | Looks credible but is neither authored nor validated | Explicit reported needs and operational stages |
| Universal transport-provider framework now | Requires contracts for unimplemented buses/helicopters and conflates Drone support with patient transport | Real Ambulance implementation; discover other Packs' actual operations separately |
| Fast mode as a high speed multiplier | Changes ramp/protection, queue, Timeline and sampling semantics | One completed-advance path with different pacing |
| Copy snapshot.json or the live directory | Omits private state or mixes checkpoint epochs | One coherent current-state checkpoint/fork boundary |
| Workers/process pool first | Adds RPC and lifecycle complexity before fixing semantics | Bounded cooperative executor; profile before adding isolation |
| Copy live sources/Agents and call it reproducible | Future external data and inference are not accelerated | Captured evidence; explicit external-controller limits |
| Rewrite Monitor into an ETL platform | Existing topology already fits the requirement | Fix semantics, query payloads and small admission inconsistencies |

This plan deliberately makes internal execution stricter while making authoring simpler. The cost is coordinated refactoring across simulation adapters and more explicit checkpoint tests. The payoff is a credible dispatch model, trustworthy restart/branch behavior and a common basis for future experiments—not another compatibility layer or a broader framework to maintain.

## Released correctness patch

Code commit `bfa7046a`, included in production release `20260903T161837Z-c7159bc60d-bee8f6e9c3`:

- Subscriber cadence recomputation with durable provider/backoff restrictions preserved.
- Shared provider provenance separated from consuming source names/attribution, using one attribution policy for current adapters.
- Consistent latitude-bounds validation, nonempty multipart geometry, and removal of duplicate Norwegian geometry parsing.
- Nullable not-retained inspection result; transient inspection failures no longer dismiss selected evidence.

Full platform checks, tests and production builds passed: World 654; Agents 1,433 with two existing skips; Host 23; contracts 18; Module runtime 11; integration one. All three services, Caddy, OSRM and public health passed after deployment. An existing Monitor Run reconnected with both sources ready, retained record inspection worked through the UI and Host broker, and a missing record returned `null`. No browser errors/warnings appeared in the smoke test. No new Workspace, Run or Room was created, and no existing Run/history/cache was deleted. Existing procedure-state and large-bundle build warnings remain outside this patch.

Stored deadlines from before the patch remain conservative until they expire or a subsequent eligible response replaces them. An old local polling interval cannot safely be distinguished from a provider restriction, so the fix does not bypass that stored deadline. New collection responses persist the separated restriction correctly. Compact search filters, validity presentation, captured branch evidence, Ambulance replacement and accelerated execution remain planned work.

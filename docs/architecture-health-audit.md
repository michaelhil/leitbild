# Architecture Health Audit

This audit records the cleanup baseline for the multi-package health pass covering control-instance memory, process-plant orchestration, runtime performance, UI architecture, and validation. It is intentionally concrete: source-of-truth boundaries, loops, known cracks, and the verification evidence expected after refactors.

## Source-Of-Truth Matrix

| Area | Canonical Truth | Derived Or Cached State | Boundary Rule |
| --- | --- | --- | --- |
| Control instance state | Projected control-instance state in `src/core/control-instances/runtime.ts`, persisted through snapshot plus durable event log | UI stores, recent-run cache, MapLibre sources, rail presentation | Providers emit events; core commits them; UI never becomes canonical truth. |
| Durable history | `events.jsonl` with monotonically increasing sequence numbers | In-memory `durableEvents` array | Sequence regression is corruption; snapshot is current truth, journal is meaningful ordered history. |
| Provider-private state | Per-provider JSON under the control-instance provider state directory | Provider runtime objects after restore | Provider state is private to the adapter and must not be reinterpreted by core. |
| Process plant graph | Scenario `processSystems` or `graphRef`, compiled by the process-plant graph compiler | Runtime variable table, execution plan, topology caches | Graph/spec validation must reject ambiguous links, variables, I&C references, and alarm references before runtime. |
| Process plant runtime | Per-system runtime variable table and elapsed time | Projected process-plant operational objects and rail/map presentation | Published variables are projected outward; continuous physics stays inside the pack. |
| I&C/alarm/trip state | Per-system protection runner snapshot | Catalog/query responses and projected active alarm/trip counts | I&C is automatic plant behavior, not a procedure engine. Procedures query it; they do not live inside it. |
| Weather state | Weather pack sparse H3/cell state and influence objects | Map weather layers and weather field query responses | Core and UI ask the pack for features/query data; they do not compute weather truth. |
| Scenario script | Scenario definition plus scenario fired-step state | Guidance overlay and highlighted objects | Script steps must be visible through committed scenario events; failures must not silently disappear. |
| UI surface | Scenario `surface` definition and live control-instance snapshot | Component-local Svelte state | Local UI state may control visibility and layout, but not simulation truth. |

## Runtime Loop Inventory

| Loop | Owner | Tick/Trigger | Writes | Failure Policy |
| --- | --- | --- | --- | --- |
| Control-instance publish queue | Core runtime | Every committed event batch | Snapshot, durable log, subscribers | Ordered queue; failures must surface instead of being swallowed. |
| Scenario script timers | Core runtime | Wall-clock timers adjusted by sim clock speed | Scenario events, object events, interaction signals | Timer/action errors are a crack if they only log to console. |
| Process plant provider | Process-plant adapter | 1 s interval, scaled by sim clock | Per-system runtime, provider state, projected object updates, I&C signals | A runtime failure now stops the provider and emits a critical provider-failed signal. |
| Process plant physics | Per process system | Fixed-step runtime phases | Runtime variable table and telemetry recorder | Acceptance traces and benchmark guardrails verify bounded trends and performance. |
| Weather provider | Weather adapter | Provider interval | Weather sparse field and weather projections | Query failures return explicit pack-query failures. |
| Ambulance/traffic providers | Pack adapters | Provider interval / commands | Pack objects and route/traffic projections | Failures should reject commands or produce explicit provider signals. |
| Map rendering | UI MapSurface | Snapshot/events/map move/zoom | MapLibre sources/layers only | Map load/style errors are shown through startup/realtime status. |

## Scenario Initialization Trace

1. Route parsing resolves `/i/<scenario>/<run>` or picker selection into a scenario id and run id.
2. Scenario catalog loads the scenario definition, required packs, provider configs, initial objects, process systems, script, and surface definition.
3. Control-instance registry opens or creates the scenario-run control instance id.
4. Snapshot and event log are restored. If the requested scenario conflicts with the stored snapshot, the run is reset rather than silently merged.
5. Simulation hub connects only the scenario’s active providers and passes each provider its private state store.
6. Providers restore private state, compile scenario-defined systems, and project initial operational objects.
7. Core hydrates projected state, initializes the clock, starts due script steps, and subscribes to provider emissions.
8. UI loads the surface, snapshot, map style, operational objects, and realtime stream. Startup status must show failures honestly.

## Fallback And Catch Audit

| Location | Current Classification | Follow-Up |
| --- | --- | --- |
| `src/core/control-instances/scenario-runner.ts` | Crack: due-step failure currently logs to console from the timer runner. | Prefer reporting failures through core committed events or caller-owned error handling in a later focused pass. |
| `src/core/control-instances/runtime.ts` simulation emission safety | Crack: publish failure logs to console and keeps running. | Needs a visible runtime error channel, but changing core event semantics is larger than this pass. |
| `src/packs/process-plant/sim/adapter.ts` provider tick | Fixed in this pass: provider tick failure now stops the provider, rejects subsequent commands/queries, and emits a critical interaction signal. | Add tests around provider-failed signaling if the failure channel grows broader. |
| UI local-storage catches | Acceptable local resilience: theme/rail settings can fall back to defaults. | Keep warnings visible in development; do not make these simulation truth. |
| Pack query `safeParse` catches | Acceptable boundary handling when converted to explicit query failures. | Keep failure responses specific and pack-scoped. |
| Weather fallback point for field construction | Needs monitoring, not changed here. | Ensure future weather queries preserve global-default semantics without hiding malformed geometry. |

## Concrete Crack List

1. `control-protection.ts` and `process-plant/sim/adapter.ts` were too broad for safe continued feature growth. This pass splits state/schema/projection/source-flow helpers without changing public behavior.
2. `process-link-flow-behaviors.ts` mixed source-flow strategy, valve limiting, capacity limiting, and leak limiting. This pass isolates the source-flow strategy so future topology work has a clear hook.
3. `docs/assets/process-plant-acceptance-traces.csv` was tracked at roughly 180k lines and churned on every acceptance run. This pass removes the tracked CSV and makes full CSV generation opt-in via `PROCESS_PLANT_ACCEPTANCE_WRITE_CSV=1`.
4. Large UI files still need lifecycle-oriented splitting after the process-plant cleanup lands.
5. Scenario and graph validation should be tightened only where refactors expose real ambiguity, not by adding broad speculative schema flags.
6. Process-plant provider config previously tolerated unknown system keys. This pass rejects those keys before runtime starts.

## Baseline Verification

Before this cleanup pass, local acceptance passed `126/126` checks at `51.7x` realtime. The local six-system benchmark measured approximately `658x` realtime for one system and `122x` realtime for six systems on the current laptop.

After the process-plant splits and artifact cleanup, local acceptance still passed `126/126` checks. The final local run in this pass measured `47.0x` realtime acceptance, approximately `542x` realtime for one system, and approximately `112x` realtime for six systems. This remains comfortably above the current `20x` acceptance threshold, and the measured spread is within local run variability for this pass rather than evidence of a new hotspot.

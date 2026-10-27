# Native-map R4 follow-up qualification

The combined application `a1c564464` passed all 32 sampled frame-p95 windows at **16.7–16.8 ms** with default and all declared layers, site and turbine-hall views, Plan and 3D, paused and playing, at DPR1 and DPR2. **One69 ms long task remains** in full-layer DPR2 site3D playing. No retry replaced that observation. The four earlier20a full-detail33.3–33.4 ms misses remain in [FINAL-NATIVE-R4](FINAL-NATIVE-R4.md); this sample does not establish that every intermittent stall is cured.

## Exact application and workload

Application: `a1c564464` (later root commits contain tests/evidence only). It adds the recognized-Orbit picking lease/bridge, top control dock/footer, and generic narrow drawer correction to20a. Geometry, source admission, material quality, sampling and source/compiler pins are unchanged. The [compact receipt](FOLLOWUP-NATIVE-R4-A1.json) contains exact pins, every measured window, raw-file hashes, lifecycle results and limits. Test helpers are `89622cdc3` and `885613fa0`; the GPU observer is `9b63d26e6` already integrated separately.

The actual local Host/World uses five placements and two immutable source families (four units and one campus), Chrome156, eight reported logical CPUs, DPR1/2, and a1080×871 CSS-pixel map. Each four-second motion window uses actual input; all layers are enabled through declared UI controls, and current VBO keys must contain every mesh-producing requested layer. Plan requires actual authored HP/LP1/GEN/TURBINEHALL text and non-upside-down text transforms. Physical3D uses the unchanged32F depth pass with4×MSAA. No scene/count cap, geometry omission, reduced sample rate, or separate browser camera was introduced.

## Recognized navigation demand

A frozen20a versus lease-only273c replay preserved all four Orbit START and END native MVPs exactly and showed nonzero camera motion. Site paused/playing readPixels calls fell136→1 and130→1; room paused/playing fell118→1 and122→1. Sampled readPixels CPU time fell445.5→1.7 ms,349.2→9.7 ms,77.2→3.4 ms and78.3→1.5 ms respectively. Both replay frame samples already met16.8 ms; this supports removal of unnecessary hover picking, not a cure claim for the original four misses.

The old acceptance did not capture original MVPs or event timestamps. The replay reconstructs original move counts and position formula, uniformly timed over four seconds. It is not relabelled as the original trajectory. Native Plan Pan already performed one readback per window before and after; no broader Pan interception was added.

The final real UI witness captures trusted pointer events after mount and observes all WebGL2 contexts, including Deck’s offscreen picking target. It preserves the initial click/activation read, then verifies zero hover reads across repeated recognized Orbit movements, actual camera change, Escape/trusted release, and a fresh unheld Deck hover read after cancellation. A real routed-edge hover then opens its owner-stamped card and exact values-and-alerts detail; an ordinary no-drag layout-body click opens the owner overview. Public Addweather→Cancelplacement, pending-layer continuity, truthful injected layer failure→public Retry, and rapid roof-layer toggles all pass. No Unknownsubject or fabricated readings are accepted. Page exit leaves no physical workers or exceptions.

The first early document-based observer had empty input-event arrays: its `whileHeld` fields are invalid and are excluded from claims. An intermediate map-canvas-only read counter missed Deck’s offscreen context. A subsequent deliberately strict check included initial mousedown picking and failed; that raw failure is retained. The final witness distinguishes preserved initial activation from recognized repeated movement. Other style/context/deactivate terminals retain25focused tests/210assertions; no new private product lifecycle framework was added.

## Cold delivery and floor reuse

A fresh local server restore and fresh Chrome profile give **2037.7 ms dispatch→first actual3D draw**, **2507.4 ms→both source families/all five placements**, then **2531.7 ms→a new GPU fence completion**. These are default-layer cold milestones, not full-layer cold, WAN transfer, or a physical-monitor timestamp. Full immutable sources are acquired; hidden mesh layers are deferred until requested.

| Action | First matching draw/ink | Additional preparation |
|---|---:|---:|
| First hall focus |21.8ms|0|
| First operating3D |314.2ms|1|
| Warm operating afterGC |33.9ms|0|
| Warm Stack afterGC |37.5ms|0|
| First uncut Stack |817.7ms|1|
| Warm cutaway return |35.9ms|0|
| First operatingPlan |180.9ms ink;206.7ms paint opportunity|1|
| Warm operatingPlan afterGC |8.6ms ink;52.9ms paint opportunity|0|
| Plan→operating3D |274.8ms draw;288.1ms fence|1|

The last row honestly retains working-set eviction/repreparation. Plan’s two scheduling frames are not called GPU completion. Source compile response is1124.1ms unit and735.0ms campus; preparation/queue/transfer details are in the receipt. All cold actions end with fresh applicable owner evidence; no worker targets survive page closure.

## Scope of the diagnostic evidence

A separate frozen20a matched-Home CPU profile found substantial Deck sync picking/readPixels cost; it did not isolate live status as the cause of the original failures. Asynchronous GPU queries measured distinct draw and resolve intervals. At DPR2 draw medians are about6.2–6.4ms and resolve about2.7–2.8ms; these are elapsed intervals, not utilization counters, and their marginal p95s must not be added. The installer excludes owned-target clear/full-screen composite and retains unsupported/disjoint/pending metadata. No source/shader reduction was made for this lease.

At DPR2 the actual2160×1742 physical target reports60,203,520bytes depth,60,203,520bytes multisample color and15,050,880bytes resolve; Plan Canvas RGBA backing is at least15,050,880bytes. These inventories exclude driver/process overhead and are not RSS. Prior optional own-Chrome RSS is explicitly a sum of process mappings, not PSS or server memory.

Current-guidance startup was also checked on a fresh authored offsite Definition: briefing/X and clean map, headerView→Gridoperations, all optional panels closed initially, retained alarm count, reopen/hide, refresh and per-Run isolation, narrow menu, stale-channel refusal. The startup report is from20a; these source/protocol semantics are unchanged by a1, whose six actual responsive/Home cases are independently documented by the UI lane.

## Reproduction and retained evidence

Run the committed `native-map-loading-probe.ts`, `native-map-product-probe.ts`, and `native-map-route-product-probe.ts` against an isolated local Run with `LEITBILD_LOADING_TESTED_COMMIT=a1c564464`. Use product probe DPR1/2 with default and `LEITBILD_NATIVE_ALL_LAYERS_ON=1`; route proof uses `LEITBILD_NATIVE_COMBINED_INTERACTION=1 LEITBILD_NATIVE_LAYER_LIFECYCLE=1`. Optional profiling/GPU/replay flags are diagnostic and must not be substituted for clean qualification.

All32windows have pending0, renderererrors0, exceptions0 and page-exit physical-worker count0. The current69ms task and previous misses remain explicit. Raw artifacts, hashes, exact runner/instrumentation hashes and screenshots are linked by absolute paths in the JSON; no private source payload or persisted Run state is copied into this evidence directory. Root’s obsolete temporary IABtab was closed before final qualification; it was unchanged during both replay halves and is not assigned causal blame.

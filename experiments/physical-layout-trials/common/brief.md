# Matched source and renderer trial brief

Frozen 24 October 2026 before contenders begin implementation. Approved scope: the reviewed integration plan v2, SHA256 `ad7f78a7c8601a487d0285628545e4c1cb3efdc927fa1beafdfbab588ffe6ff3`. This experiment is not a production Pack, qualified layout or live-state integration.

## Shared source acceptance

Both source contenders use the same F1–F4. Metres, right-handed Z-up is the interchange/check frame. Save source, close it, and rebuild in a fresh process without importing the original fixture or a second per-plant coordinate recipe. Reusable family/compiler tooling is permitted and counted. Raw IFC imports may remain read-only with exact unsupported/editability reports; neither contender must invent lost construction history.

- **F1:** `f1-original.json` freezes the accepted 88×36 m turbine hall and 32×16 m adjacent room, 0/+15 m levels, 16 occurrence IDs, seven operational subjects, architectural walls/openings/stairs/hatch and shaped machinery. Retain the established visual style. The source JSON is an input brief, not a second editing authority after canonical save. Reference visuals/code are retained on branch `codex/plant-layout-authoring-trial-20261023` under the previous turbine-hall/3D/map experiments.
- **F2:** wall `edit-wall` in a distinct cell, local origin `[110,0,0]`, 30° rotation around Z, length 12 m, thickness .3 m, height 6 m. Existing opening at local distance 1 m, width 1.2 m, height 2.4 m. Add `access-door` at distance 7 m, width 1.4 m, height 2.7 m with actual void/filling, swing and space adjacency. Roof-only raise 6→8 m preserves the +3 m deck and pump datum. Separate deck edit +3→+3.5 m updates the named stair/landing/riser/support; an unsupported dependency must refuse. Unrelated fixed vessel stays at `[125,20,0]`. Independent max-clear-height requirement is 9 m; attempted 10 m is rejected.
- **F3:** two instances of F1, member IDs `unit-a`/`unit-b`, owner IDs `plant:trial-a`/`plant:trial-b`, local placements `[0,0,0]` and `[160,0,0]`, same-label pumps but distinct qualified identity. One directly site-contained shared yard at `[80,-60,0]`, transformer and first support; two circuit memberships may share that support. Also instantiate reusable design in two independent site scopes. No duplicated shared yard, native duplicate IDs or cross-instance picks/state.
- **F4:** `corpus/phase-a.ifc`, `phase-a-edited.ifc` and `unsupported-content.ifc`. Freeze raw hashes before any reader/writer. Report actual retained subset, object/port/opening/relationship counts and unsupported/lost information. Export/reopen IFC from both contenders and check declared facts. No replacement of detailed imported geometry by boxes; honest read-only retention/rejection is valid as declared.

## Mandatory operations and negative controls

1. Genuine parametric horizontal pump/motor and turbine family regeneration from saved authority. Type-wide pump length +10% updates both feedwater pumps and dependent interfaces/envelopes; A-only +.5 m variant preserves B.
2. The rotated hosted-door edit, roof-only edit, enumerated deck edit, pump-assembly +2 m east move and F3 composition preserve unrelated identity/geometry. Compare complete intended/actual semantic diffs, not only a handpicked changed object.
3. Source-only plan vectors/SVG, solids/mesh delivery, bounds, physical interfaces and pick IDs agree. Store structural and equipment quality evidence; a valid file or coarse shape alone does not close visual fidelity.
4. Reject stale base, unrelated collateral edit, unsupported dependency/source, inconsistent authoritative parameters/body, independent height-limit violation and stale binding/study. Keep old accepted source readable. Do not silently alter process parameters or a governing requirement.
5. Record parse/save/reopen/regeneration timing and peak/resource estimate, source/output bytes, added dependencies, maintained code/family/editor/adapter responsibilities. Shared code is disclosed and counted for each whole path.

One implementation attempt and one recorded correction round per candidate, then complete recheck. No moving must-passes or new desktop/server/CAD solver to rescue a contender. Stop at completed receipts or fixed envelope (maximum two specialist workdays per candidate plus one independent checking day). A failure within this envelope is not proof of intrinsic format incapability. Select a source only when every mandatory check is supported; otherwise report the exact unqualified remainder. If both pass, compare total burden and product fit, not standards prestige or initial line count.

## Renderer comparison

One MapLibre map/camera/shared WebGL2 context; exact installed MapLibre `6.0.0-11`, Babylon core/loaders `9.23.0`. Native and Babylon consume identical geometry/workload. No independent animation loop or production runtime changes. First test shared color/depth/stencil/state preservation, projection, layer ordering, picks and context restore/disposal. A correctness failure stops that candidate before scale claims.

Workloads: F1 16 occurrences; synthetic 500-occurrence building using repeated shaped families; four unit instances plus one shared yard. Include level isolation and labelled display-only separation; status-only updates cannot rebuild geometry. Test base/reference, scene, operational line/zone/icon and HTML composition. Timing acquisition/render independently; synthetic state is explicitly a benchmark fixture, not a simulated plant reading.

Capture named hardware/browser/viewport/DPR/backend, cold/warm ready, incremental compressed bundle/asset bytes, frame p50/p95/p99, pick/occlusion correctness, state application, idle repaint, estimated CPU/GPU resources and 20 lifecycle/style/focus/context cycles where actually executed. Desktop target total p95≤20 ms; constrained target≤33 ms only if measured on a named constrained profile. No fake device emulation result, no automatic FPS claim from screenshots.

Decision order frozen now: correctness/envelope, constrained resource and interaction limits, incremental download/startup, owned maintenance. Prefer Babylon on meaningful measured parity only if it reduces owned engine responsibilities inside the budget. A smaller native file or existing Babylon installation alone does not win. No arbitrary sections/caps/GLB support claim unless exercised. The result must distinguish passed, failed, unexecuted and unsupported checks.

## Delivery

Each agent owns its contender directory, receipt and reproducible tests; commits explicit files in its own worktree with coauthor trailer. No pushes/deploys by subagents. Coordinator independently reruns commands, checks negative outcomes and source-only reproduction, visually reviews source-derived outputs, selects the recommendation and publishes concise durable wiki knowledge. Never write private reasoning transcripts into the wiki: document rationale, alternatives, contracts, decisions and evidence limits.

# Independent loading optimization acceptance

The final candidate improves cold site readiness and first floor drawing without changing the retained plant source or visual quality. The strongest cache result is the forced-GC **Plan operating-floor return**: first matching draw falls from 235.1 ms to 17.6 ms, with zero new preparation instead of one. The separately observed settled checkpoint falls from 259.5 ms to 32.6 ms. The 3D return still legitimately prepares and uploads again after eviction; it is not described as cache warm.

## Exact paired protocol

Built baseline app `4f309c67c` and built candidate `54de577804561968133b8904699c7687da618be2` ran against the same paused isolated Run on the same loopback stack, Apple M2/browser and 1440×913 DPR 1 viewport. Each run uses a fresh isolated Chrome profile. Their compiled instrumentation hashes are equal. All five detail placements are confirmed by actual draws of four unit-family instances and one campus instance in each site gate. There is no geometry substitute or object-count cap.

This is one paired full-product sequence, not a statistical latency distribution. The old fixed 500/700 ms scope/floor helper sleeps are excluded. Worker source/preparation events, requested typed-array→VBO/VAO→TRIANGLES draw, forced-GC boundaries, owner HTTP acquisition and validated live-status text are retained. Instrumentation uses weak keys and primitive-only logs rather than retaining the arrays whose collection it tests.

**Milestone names matter.** `actionToFirstDrawMs` is the first real matching target-view draw. The raw `actionToGpuCompletedMs` field is a later **settled GPU checkpoint**: all observed physical jobs must drain before a fence is accepted, and site cases also require five layouts ready. It is not the first target-frame fence signal. Selected floors can appear while unrelated mode preparation continues. Owner freshness is checked only after this checkpoint, so it is an observed-by upper bound, not the first fresh arrival or precise restart latency. The raw receipts are unchanged; this report and the compact summaries clarify their semantics.

## Product results

Values show baseline → candidate. Milliseconds are rounded to one decimal. Small warm-view differences are frame-scheduling observations from one run, not statistical regressions or speed guarantees.

| Action | First matching draw (ms) | All-work-settled GPU checkpoint (ms) | New prepare posts |
| --- | ---: | ---: | ---: |
| open-browser-cold | 1864.0 → 1643.5 | 3689.3 → 2855.8 | 4 → 2 |
| site-3d | 22.9 → 23.1 | 42.1 → 31.0 | 0 → 0 |
| first-turbine-hall-focus | 17.9 → 20.6 | 29.0 → 28.7 | 2 → 2 |
| first-operating-3d | 313.4 → 264.0 | 338.4 → 278.6 | 1 → 1 |
| first-stack-3d | 22.1 → 21.6 | 35.7 → 31.8 | 0 → 0 |
| gc-return-operating-3d | 287.0 → 251.6 | 299.0 → 267.2 | 1 → 1 |
| gc-return-stack-3d | 26.7 → 25.2 | 32.8 → 32.5 | 0 → 0 |
| first-uncut-stack | 1119.0 → 919.9 | 1132.4 → 930.7 | 1 → 1 |
| gc-return-cutaway-stack | 27.8 → 25.1 | 35.8 → 31.4 | 0 → 0 |
| first-plan | 514.8 → 439.2 | 542.1 → 448.6 | 3 → 3 |
| first-plan-operating | 232.3 → 197.9 | 259.3 → 212.8 | 1 → 1 |
| first-plan-lower | 5.8 → 16.4 | 17.9 → 31.5 | 0 → 0 |
| gc-return-plan-operating | 235.1 → 17.6 | 259.5 → 32.6 | 1 → 0 |
| return-3d-operating | 301.6 → 233.9 | 1767.2 → 1315.4 | 3 → 2 |
| gc-fresh-browser-owner | 1110.1 → 934.5 | 2714.9 → 2041.2 | 4 → 2 |

Five-layout cold readiness at the settled checkpoint improves 3689.3→2855.8 ms (about 23%); fresh browser owner after GC improves 2714.9→2041.2 ms (about 25%). First operating 3D draw improves 313.4→264.0 ms. On Plan→3D return, first target drawing improves 301.6→233.9 ms, while the later global checkpoint improves 1767.2→1315.4 ms. These two intervals must not be conflated.

In ten selected-room floor/Stack/cutaway/Plan phases, baseline starts a presence acquisition each time; candidate starts none. Total presence requests are 23→13, and layout reads 34→28. Background polling and legitimate site-owner changes remain, so total request differences alone are not the causal proof. Existing scope, epoch, sequence, role and freshness validation remains in the production reader. All observed selected-owner statuses become validated `Paused · fresh` with 108 modelled subjects.

Source compilation is separately visible: baseline unit-family/campus post→first-result times are 540.8/624.9 ms, with immediate source-worker termination after each valid result. Exactly two source compilations serve five placements. The source compiler and its canonical pins were not changed by this optimization.

## Actual resource and lifetime proof

The bounded engine fixture uses real five-layout delivery, actual canvas/map ports and the real module worker. Two real frame boundaries bracket forced GC so a diagnostic WeakRef dereference cannot keep referents alive during collection. It records actual residency and eviction, rather than treating the hypothetical all-variants census as resident memory.

| Measured phase | GPU geometry bytes | Resident derived CPU bytes | Plan pass bytes | Evictions | Pool retained derived CPU bytes |
| --- | ---: | ---: | ---: | ---: | ---: |
| site-five-ready | 27,265,584 | 83,878,040 | 0 | 0 | 83,878,040 |
| stack-after-gc | 15,354,192 | 48,030,708 | 0 | 1 | 95,131,516 |
| return-operating3d | 15,354,192 | 48,030,708 | 0 | 1 | 95,131,516 |
| lower-plan-after-gc | 25,611,360 | 79,778,772 | 47,329,920 | 1 | 79,778,772 |
| return-operating-plan | 25,611,360 | 79,778,772 | 47,329,920 | 1 | 79,778,772 |
| first-owner-closed | 3,367,152 | 10,563,700 | 47,329,920 | 0 | 10,563,700 |

Both returned surviving 3D and Plan variants in this bounded sequence have zero preparation and zero geometry-upload deltas. This sequence is separate from the product workload: the product's 3D variant was evicted and properly rebuilds. “Stack” here means all floors with separation zero; no nonzero exploded-level cache result is claimed.

The second actual unit owner picks `layout:halden-2`, target `plant:halden-2`, occurrence `tg-hp`, subject `turbine`, proving shared CPU geometry is rebound to its current owner. After both hosts close, the worker is dead; pool clients, registered sources, leases, jobs, queued views, retained views and retained bytes are zero. Both physical renderer contexts report zero owned buffers/programs/textures and zero surviving Plan framebuffers/renderbuffers.

CPU byte diagnostics count derived typed storage, excluding source arrays and JS metadata. Pool bytes include controller-held assets and the resident subset and are not additive with backend CPU bytes. Shared per-host assets must not be added as distinct physical memory. GPU geometry bytes exclude status/instance storage, Plan allocations and unrelated MapLibre resources; the table is not total GPU or JS heap usage.

## Visual and source acceptance

Fresh final-source primary controls pass all 24 phases at actual DPR 1/2: **15,268/15,268** correct GPU material and exact CPU picks, including Plan and exposed-column controls. The actual separated-paint control passes eight phases, **440/440** samples. No material winner flips, GL errors or renderer errors occur. Frozen source fixture digests and every uploaded camera matrix equal the prior qualified final-source controls.

All production source trees used by these new probes equal root `a4ce7c9ba8ac7da30b09a2cfc98c12fbaa1c7079`. The algorithm specialist separately supplied seven-variant byte equivalence for geometry/normals/materials, ownership alternatives, render buffers and packed pick acceleration; my static review found no change to surviving source ordering or numerical predicates. This proof does not claim arbitrary geometry/hardware qualification or a complete variant matrix.

## Evidence and integration

- `baseline-4f-final/` and `candidate-54de-final/`: immutable raw product receipts, compact semantic summaries, screenshots and hashes.
- `visual-54de/`: four raw/compact visual runs, selected screenshots, source/matrix comparison and hashes. Each compact visual receipt is below 1 MB.
- `cache-residency-54de/summary.json`: 38,895-byte resource/GC/owner/closure receipt; full raw receipt and hashes remain alongside it.
- `source-manifest.json` and `comparison.json`: exact production trees, physical-scene source hashes, paired observer/workload invariance and results.

The root already integrated the timing runner, resource test and checkpoint clarification. Test-only console compaction `76dd8067f` avoids printing repeated ownership diagnostics; it changes no measurement or production source. Calibration `debug-baseline-1/` is explicitly excluded. All of my isolated probe processes and loopback servers stopped before root resumed its independent moving/product checks. No production Run or deployment was changed by this proof agent.

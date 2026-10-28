# Ownership overlap index: 28 October 2026

This evidence qualifies a replacement for the overlap hierarchy only. The ray hierarchy, conservative overlap predicates, surface partitioning, source precedence, native geometry and rendering remain unchanged. The replacement splits the widest centroid spread at its spatial midpoint, retains exact union bounds, and uses one primitive per leaf. Identical or representably adjacent centroids use a deterministic primitive-ID median fallback. Construction uses typed primitive IDs and an explicit stack; it has no content or leaf-size cap.

## Fresh-process CPU comparison

Each of the eight receipts records one fresh Bun process and one measured ownership call on the exact retained R5 unit or campus, with all utility layers and inspection alternatives present. Source compilation and mesh generation occur before the interval; exact geometry, render-buffer and picking-array fingerprints occur after it. One test-only GC precedes each process's measured call. The second pair reverses the order. The index algorithm is identical in both pairs; the second runner additionally records memory inventory outside its timed interval.

| Source | Pair | Original ownership | Midpoint ownership | Reduction |
| --- | --- | ---: | ---: | ---: |
| Unit | First | 2740.1 ms | 1956.9 ms | 28.6% |
| Unit | Reverse | 2492.3 ms | 1813.4 ms | 27.2% |
| Campus | First | 1255.5 ms | 990.8 ms | 21.1% |
| Campus | Reverse | 1318.8 ms | 1082.6 ms | 17.9% |

[paired.json](paired.json) retains every receipt and the exact source/compiler identities. All four results for each source have the same fingerprint, including ordered vertices, normals, material roles, authored lines, ownership masks, packed render buffers and picking arrays. Only the broad-phase work counter is excluded: a different hierarchy deliberately changes candidate enumeration work.

These are Bun ownership CPU measurements. They are not browser loading, worker transport, network, frame-time or end-to-end speed results. Actual product qualification is a separate gate.

## Memory and retained resources

| R5 source | Retained picking indices, unchanged | Packed render bytes, unchanged | New transient ownership index |
| --- | ---: | ---: | ---: |
| Unit | 19,026,788 | 29,252,592 | 32,158,436 |
| Campus | 7,948,872 | 18,569,040 | 17,403,476 |

Atomic leaves require more transient hierarchy nodes than an SAH hierarchy that groups primitives into leaves. The new temporary index inventory follows the exact populated nondegenerate ownership cohorts: `(2N − 1) × 64 + N × 4` bytes per cohort. This index is local to ownership construction and is absent from the returned prepared asset. Retained source, picking and GPU geometry budgets do not acquire a new cache.

The receipts also retain after-call process RSS and operating-system process peaks. These fell in the measured pairs, despite the larger transient index, but include the process's other allocations and later verification work. They are not a retained ownership/GPU memory budget or a browser memory claim.

## Correctness and scope

The production change replaces only `createPhysicalOverlapSpatialIndex` and its explanatory comment. Existing `visitPhysicalSpatialBounds`, pair eligibility, plane tests and source-order sorting remain authoritative. Exact node unions plus the same conservative query margin cannot discard a pair admitted by the existing bounds predicate. Candidate enumeration order may differ; the caller sorts surviving original face ordinals before partitioning.

The focused suite passes 35 tests / 10,216 assertions. It covers empty, identical, adjacent, planar, skewed and heterogeneous bounds; exact frozen-b748 ownership/render/picking output for actual R6 unit and campus with all layers, every source floor, cutaway changes, separated levels and turbine inspection scopes; and existing architecture BSP and real-worker admission/lifecycle tests. World type and Svelte checks pass with zero errors and zero warnings; [validation.json](validation.json) records that boundary.

The prototype fixtures remain test-only replay artifacts. The production function retains its existing private name and `PhysicalSpatialIndex` interface. No source revision, CAD model, public API, rendering order or quality setting changes in this optimization.

The performance specialist separately rejected global, two-stage, refined SAH and ray-builder alternatives that did not improve total work consistently. Their retained [negative comparison](../detail-latency-20261028/ownership-alternatives.json) and [method notes](../detail-latency-20261028/README.md) explain that context. They are not substituted for this candidate's own receipts.

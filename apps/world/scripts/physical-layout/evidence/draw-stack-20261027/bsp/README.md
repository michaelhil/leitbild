# Global architecture partition: bounded CPU evidence

This evidence concerns the ordered transparent architecture geometry only. It does not qualify browser cold loading, map motion, opacity pixels, GPU resources or the complete product.

The full admitted R5 site contains four placements of unit Design `95c2f1c11a22e85230f11bd37d1c0c331b8a68e1f23111f1e29baed81beacae9` and campus Design `91f901b8c822e9738554b8e9d9bbfdcf679615efa3dfc05f5b51d7f054a92933`. The census prepares all mesh-producing layers, every wall/slab mesh and the complete camera-boundary alternatives. It includes 8,026 source records, 125,536 triangles and 32,168 authored segments. Its all-owner visibility mask deliberately exceeds an actual camera's admitted surface-ownership mask.

`redundant-partition-diagnostic.json` records an early correct but wasteful implementation: repeating the already prepared source-ownership partition produced 1,007,690 triangles and 222,504,768 bytes of Float64 vertex storage. Its 10.6-second construction and 118.6-millisecond traversal are diagnostic samples, not a controlled paired performance comparison. A preceding census attempt also exposed a generated zero-length line remnant; keeping each authored line's support plane through splits fixed that issue. These failures are retained in the research directory.

The current input explicitly identifies the exact prior ownership cohort: prepared asset, placement and original offset/semantic band. Only these proven pairs reuse their prior solid-ownership partition. Every cross-cohort coincident patch still receives the global partition, and all geometry and camera alternatives remain present. Renderer visibility must already apply `visiblePhysicalSurfaceOwners`; the generic field never permits raw unpartitioned geometry to claim that proof.

`final-census.json` records the clean CPU interval after all agents released checks and browsers. Construction took 1,502.6 ms, with 137,904 output triangles, 33,637 original-line fragments, 6,861 tree nodes and 34,630,992 bytes of Float64 vertices. The vertex-buffer SHA-256 is `e361b6d532cdb97c919d3ab2e819ca22fe49195643cd5a791a0eeee650d04111`. The first all-owner traversal took 12.19 ms. Sixty nearby camera poses retained the exact same plane-side and owner-mask topology; all reused the same immutable order array, with median 0.150 ms and p95 0.808 ms. These are standalone Bun CPU measurements, not frame-time claims. The previous census with uncertain overlap against another agent's ending checker is preserved separately and is not the clean sample.

The order cache retains one current result per live BSP in a WeakMap. It invalidates on any plane-side or visible-owner change. Its exact additional typed storage for this census is 194,438 bytes, exposed by `physicalArchitectureBspTraversalBytes`. This value and geometry-buffer bytes are neither total JavaScript heap nor process RSS.

Focused correctness checks cover intersecting/cyclic planes, first-source coplanar partial overlap, real holes, opposite winding, same-owner material interfaces, hidden-winner fallback, prior ownership selector equivalence, cross-placement partitioning, source-local attributes and normal interpolation, flat provoking-vertex materials, authored line conservation, near-but-distinct planes, finite homogeneous cameras, worker provenance/tree validation, actual module-worker execution, independent cancellation and disposal. GPU raster acceptance is a separate oracle owned by the integration team.

Reproduce from `apps/world`:

```sh
LEITBILD_ARCHITECTURE_SOURCE_ROOT=/absolute/path/to/frozen/apps/world \
LEITBILD_ARCHITECTURE_EVIDENCE_DIR=/absolute/path/to/output \
bun --no-env-file run scripts/physical-layout/architecture-bsp-census.ts
```

The source-root override must resolve the admitted R5 Designs above to reproduce this exact population. The command compiles the authored Scenario locally and calls no production Run APIs. Source/compiler/Design pins are unchanged by the partition engine.

# Cold preparation algorithm optimization

Baseline: main `4f309c67c7a1bd69a7eb9cac7363f8f2979e3f4b`. Candidate: `82791a253` then `11e9f59cc077fded26dd792beed7852dfc952dd5`, developed in the separate `codex/physical-loading-algorithm-20261026` branch. No production Run mutation, rendering policy, authoring source, compiler profile, Design pin, physical offset, quality reduction, feature cap or numerical tolerance change.

## Diagnosis and changes

The initial 6.02-second CPU profile of four exact source/view preparations attributed 38.2% inclusive time to the ownership face loop. Sorting cost 11.0% self time: about 378 ms in ownership candidate order and 285 ms in spatial construction. Conservative bounds traversal cost 9.6% self time; repeatedly computing spatial unions cost 7.3%. The complete visible-mesh construction path occupied about 7.7% inclusive time, so optimizing its fallback normal computation was not the first priority.

The first change applies the existing immutable projected-box and numerical plane predicates before saving and sorting candidate faces. Only actual survivors need original source ordering. Diagnostic broad/coplanar counts, source tie rules, region partitioning and their arithmetic are unchanged.

The second change removes callback allocation for the fixed two projected axes and three triangle vertices, preserving predicate order and arithmetic. Spatial construction passes the already-computed child union into recursion instead of scanning identical child primitive bounds twice. SAH decisions, leaf policy and packed hierarchy remain identical. There is no new tree split threshold.

## Measured result

One sequential paired cold CPU pass, after source compilation and with explicit garbage collection outside each timed interval:

| Source and view | Baseline ms | Candidate ms | Reduction |
| --- | ---: | ---: | ---: |
| Unit, 3D All cutaway | 1226.0 | 1011.3 | 17.5% |
| Unit, 3D operating floor | 328.1 | 258.5 | 21.2% |
| Unit, separated All | 1305.6 | 1066.2 | 18.3% |
| Unit, Plan operating floor | 326.0 | 246.3 | 24.5% |
| Unit, uncut 3D All | 1318.5 | 961.0 | 27.1% |
| Campus, 3D All cutaway | 1946.8 | 1400.7 | 28.1% |
| Campus, uncut 3D All | 1994.1 | 1426.2 | 28.5% |

The subsequent four-case candidate profile took 5.07 seconds. Its hottest remaining path is conservative spatial traversal, around 28% inclusive; sorting remains about 12.5% inclusive. The baseline and candidate profile totals are separate instrumented runs, not a paired statistical comparison. These timings do not include source compilation/transport, worker scheduling, GPU upload, painted-frame completion or actual live UI operations.

## Correctness and reproducibility

All seven cases match the frozen baseline hashes exactly. The fingerprint includes prepared Float64 vertices/normals/material indices and lines, mesh order and owner masks, Plan priority, offsets/bounds, relevant occurrence/material/binding metadata, every packed pick BVH, Float32 render data, role lists and ownership diagnostics. The benchmark key itself is intentionally excluded because baseline and candidate jobs have different diagnostic keys. This is evidence for these actual retained sources and views, not a claim of byte equivalence for every possible admitted model.

Focused suites: `physical-surface-ownership.test.ts`, `physical-spatial-index.test.ts`, and `physical-render-assets.test.ts`: 21 tests and 9,341 assertions pass. They include partial overlaps, holes, hidden-winner fallback, intra-object ties, thin triangles, opposite winding, representably distinct planes, source-order picking and actual controller filter behavior. Full-product and independent temporal GPU gates belong to the integrated candidate and are not claimed passed by this CPU report.

From `apps/world`, reproduce the paired comparison with:

```sh
LEITBILD_PHYSICAL_BASELINE_ROOT=/absolute/frozen-baseline/apps/world \
LEITBILD_PHYSICAL_REQUIRE_EQUIVALENT=1 \
bun scripts/physical-layout/surface-preparation-probe.ts
```

Run the single-side CPU profiler with:

```sh
bun --cpu-prof --cpu-prof-md --cpu-prof-dir=/absolute/output \
  scripts/physical-layout/loading-cpu-profile.ts
```

Receipts: `cpu-baseline.json`, `profile-baseline/`, `profile-attribution.json`, `sort-attribution.json`, `cpu-presort-filter.json`, `cpu-scalar-child-bounds-7cases.json`, `cpu-candidate-profile.json`, `profile-scalar-child-bounds/`, and the compact `algorithm-summary.json` containing source/receipt hashes. Test receipts are `presort-filter-tests.log` and `scalar-and-child-bounds-tests.log`.

## Remaining work boundary

Cold work remains material: about one second for a unit and 1.4 seconds for the campus in this pass. The separate residency/cancellation changes should remove repeated work and obsolete queued jobs; only the combined full-product experiment can establish the user-visible gain. A two-level object/triangle broad phase could target the remaining traversal cost, but would change the hierarchy and diagnostics and require a new proof. It is not included in these byte-preserving changes.

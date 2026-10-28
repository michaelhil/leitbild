# Ownership-query experiments and ray-ordering correction

This CPU qualification follows application `55771e2ee419527aeefd07350bc6eb40528c1f7f` on the same R6 native unit and campus. It changes temporary surface-ownership queries, not authored geometry, Plan ink, materials, output ownership, rendering or ray picking. Actual product loading remains a separate browser gate.

## Evaluated query changes

- Each temporary overlap node records its minimum original face ordinal. A face asks only for preceding faces, so a subtree containing exclusively later faces cannot contribute. The existing pair predicates and surviving original-order sort remain unchanged. Faces in the same mesh are still eligible.
- Query coordinates and their positive magnitudes are evaluated once, and the three node axes are expanded explicitly. The selected maximum, floating-point padding operations, X/Y/Z rejection order and child visitation order remain identical.
- Raw closed intervals which already overlap necessarily pass the nonnegative padded test. Only separated axes perform the original padding calculation. Near-boundary candidates still receive exactly the same conservative arithmetic.

The callback's pair-bounds predicate is deliberately retained. Although the atomic leaf has the same physical bounds, its query test uses the reverse subtraction/addition orientation. Rounding at error boundaries must not be assumed interchangeable. No plane bucketing, approximate normals, candidate truncation or detail limit is introduced.

These are qualified alternatives, not a requirement to retain every experiment in production. The delivery owner subsequently evaluated a standard dual-tree pair traversal which can supersede per-face prefix queries and their temporary ordinal metadata. The final combined release receipt identifies the selected implementation.

## Fresh-process CPU observations

Each sample starts a fresh Bun process, resolves the exact R6 design and constructs its meshes before timing one ownership call. One explicit test-only GC precedes the interval. Ordered geometry, diagnostics, packed draw bytes and ray-picking arrays are fingerprinted after the interval. The scalar and raw-interval comparisons import frozen predecessor source files, preventing the comparator from accidentally using the new visitor. The clocks exclude compilation, fingerprints, worker startup, transfer and GPU work.

| Isolated step | Unit before → after | Campus before → after |
| --- | --- | --- |
| Source-prefix query, final constructor | 1,227.5 → 1,229.8 ms; 1,236.5 → 1,221.4 ms | 677.1 → 582.0 ms |
| Invariant magnitudes and scalar axes | 1,260.1 → 1,133.4 ms; 1,360.6 → 1,307.0 ms | 1,056.0 → 578.1 ms; 601.4 → 513.5 ms |
| Raw-overlap fast path | 1,143.7 → 1,046.6 ms; 1,071.5 → 1,058.0 ms | 530.6 → 507.4 ms; 531.3 → 512.8 ms |

These are sequential step comparisons, not additive reductions or a controlled end-to-end loading claim. The 1,056 ms campus predecessor is an outlier; every sample is retained rather than selecting the largest gain. Prefix pruning alone is effectively neutral on the unit and improves campus. The complete candidate still requires the actual built-map qualification.

Every before/after result has the same complete fingerprint: unit `93ec4518304c357cc5be37568bd753327ebf1e6d3e0a632945ff0332b811be05`, campus `c5c7acd1f2f4f9bc73b820ec9c53dab72d305ea5b375ca7a40358117a270a463`. Their packed bytes remain 29,589,600 and 18,569,040 respectively. Broad-phase counters also remain equal.

## Memory and correctness

The prefix candidate adds four bytes per temporary overlap node: 1,953,604 bytes for the all-floor R6 unit and 1,054,756 for campus. Equivalent unit placements share a source family. This metadata dies with ownership construction; the returned asset retains no overlap index. Ray trees do not acquire it, and prepared CPU/GPU/picking buffers are unchanged by the ownership candidates. This temporary cost must disappear if another traversal supersedes prefix pruning.

The ownership focused suite passes 22 tests / 16,003 assertions: R6 unit/campus every floor, cutaway, separation and turbine inspection scope preserve frozen geometry, normals, materials, authored strokes, conditional ownership, packed rendering and picking arrays. It also covers exact source-prefix sets and candidate order for both ray and overlap trees, floating error boundaries, negative zero, subnormal coordinates, large translations up to `Number.MAX_VALUE / 4`, robust coplanarity and actual architecture-worker ownership/lifecycle. Native Plan interaction and combined product timing are separate qualifications.

## Native-browser follow-up and a genuine picking defect

The same isolated experiment was repeated in actual fresh Chrome Workers because Bun CPU gains did not predict a clear whole-product improvement. Each Worker receives the complete R6 scene through the production transfer helper, builds its meshes outside the timed interval, and performs exactly one first ownership call. No preparation warm-up is used. Full geometry, diagnostics, rendering and picking buffers are hashed afterward. The first and reverse samples measured baseline versus the complete query candidate at 1,484.6 → 1,165.8 ms and 1,390.7 → 1,050.3 ms for unit ownership; campus was 767.4 → 561.4 ms and 854.6 → 644.3 ms. These are V8 stage measurements, not a claim that the product's cold loading fell by those amounts.

One lazy-vertex diagnostic initially had different full fingerprints despite matching meshes, rendering and ownership diagnostics. A repeat of the baseline itself also changed its picking-tree allocation. The cause was the existing ray SAH comparator: `a.min + a.max - b.min - b.max` is left-associated, and can be nonzero even for a box compared against itself (`0.1 + 0.2 - 0.1 - 0.2`). It is not a valid ordering for `Array.sort`.

The separate correction caches finite centroid keys, calculated as `min * .5 + max * .5`, and compares the two keys before the original source-ID tie. It retains exact unions, SAH leaf choice, ray tests and source tie behavior. Half sums avoid overflow at extreme finite coordinates. Keys are temporary, not retained picking or GPU data. Tree topology and byte counts may legitimately change from the old ill-formed ordering; exact ray winners and determinism are the required gates.

After the correction, baseline and lazy unit Workers have **identical complete fingerprints**, including the picking buffers: `69ca71bf2b8cd710116cd1fa482addb33c51fec5db7ad733847583a5faed59ff` (101,253,394 hashed bytes). Their mesh section (`7dce347ae21bacf9f0ae490cd96acee08ac63c56f561322c70e95452a18ad2d6`) and render section (`fd807cc0cf13aaa7f609d869461c16be53c847e8cc5e20a46f8055ebd14cbbc9`) also match the old baseline. Fixed-ray campus baseline has full fingerprint `5ea4eda183616c40acbdaa75448ea6587f8659e8dd1c8773e58f5fed044ce995`. The independent dual-tree specialist obtained these same fixed-ray unit and campus fingerprints.

The correction passes 20 tests / 75,522 assertions, including comparator reflexivity/antisymmetry, every actual hierarchy partition, deterministic rebuilds, extreme finite and subnormal values, brute-force ray winners, source ties, active-subset ordering, real R5 floor/camera/opacity/offset hit positions, and all R6 floor/cut/scope geometry. Native Plan picking additionally passes all 57 cases at both DPR1 and DPR2 after the ray correction, covering actual glyph holes, dashes, route clipping and architectural occlusion. The earlier World TypeScript/Svelte check reports zero errors and warnings; the final combined release must repeat it after all selected changes.

## Rejected alternative and reproducibility

Lazy face-vertex materialisation removed eager allocations but lost Bun performance: quiet unit ownership rose from 1,167.6 to 1,489.3 ms and campus from 670.3 to 718.0 ms, despite identical output. The later browser diagnosis above prevents mislabeling the unrelated ray-ordering defect as a geometry failure. The allocation experiment is not selected production code. An earlier accidentally concurrent harness sequence is explicitly invalid for timing and is retained only as a failed attempt.

All 46 raw files, frozen comparator sources, repro harnesses and the rejected patch are SHA-verified in `/Users/hilde/Documents/ChatGPT/plant-layout-research-20261025/draw-stack-audit-20261028/cold-geometry-20261028`. `MANIFEST.json` has SHA-256 `ccb2ed0787c450d0f98aabcc7d716bf0e0d60cd95c16bdbac568b17bff443d1c`. [measurements.json](measurements.json) identifies each sample and its interpretation. Restore the retained `.ts` files into a checkout's `.health/` directory, then run `bun .health/raw-interval-bench.ts before unit /absolute/output.json` or `current`, and `unit` or `campus`. These are deliberately offline CPU probes; they do not contact a Run or production service.

The native-browser corpus is separate: `/Users/hilde/Documents/ChatGPT/plant-layout-research-20261025/draw-stack-audit-20261028/cold-geometry-v8-20261028`, 76 files / 9,220,481 bytes, manifest SHA-256 `3dd0c5e4545a19c38ff18b98f520b04d0f5b02dbc2b9e608ee6775b3a64fff1d`. [v8-measurements.json](v8-measurements.json) records worker-bundle identities, full fingerprints, stage timings and section diagnostics. It includes the independent dual-tree samples written through the same harness. Restore its `harness/` files beneath `.health/` in the stated application checkout, then use `bun .health/v8-cpu-probe.ts baseline .health/surface-ownership-baseline.ts unit /absolute/output-directory`. The engine argument can name another exact source module; a fresh Chrome profile and Worker are created and closed for every call. `LEITBILD_V8_DIAGNOSTIC=1` adds post-clock section fingerprints and a picking-node inventory. The early samples used the old ray builder; fixed-ray samples must use the separate ray correction. Compiled bundles are retained where captured; every receipt states its actual worker SHA rather than assuming differently bundled diagnostics are identical timing controls.

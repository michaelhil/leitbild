# Native architectural quality closure, 27 October

Tested production tree: `2a2755715162fc2335cf958fc08c14eebb0322f3`. This is a functional quality/resource qualification of that stage, not a performance result or an acceptance of a later changed backend. No production file, model, compiler, source, binding or Design pin changed during the tests.

The admitted current unit is `95c2f1c11a22e85230f11bd37d1c0c331b8a68e1f23111f1e29baed81beacae9`, with 719 delivered objects. Both actual source comparison fixtures independently resolve the current Scenario and compile its exact admitted source, producing identical scene hash `5fb4a80f97b902f61ef1731e4bd195d5fe075a576802cbd5239e95ae9fdbdd5b`.

## Results

- Native Canvas Plan ink/picking: **57 cases each at DPR1 and DPR2**, including curves, even-odd holes, actual glyph coverage, rotated/dashed ink, scope clipping, opaque blockers and zero-opacity graph-bound architecture revealing equipment.
- Native Plan paint stream: **36 phases with zero differing pixels** against independently compiled singleton ordered commands. This certifies batching equivalence, not equality to the original SVG.
- Actual native MapLibre 3D: **six phases at DPR1** (All/operating/lower, neutral and controlled status), original/native cameras and equal viewport sizes recorded. Existing contours, floor bands, columns, windows, crane, stair/railings and machinery ribs remain visible in the retained side-by-side images.
- Controlled status witness: **588 contour pixels changed, all 1,024 sampled interior pixels unchanged**, no geometry reupload, in each of 2D and 3D. The fixture colours are test inputs, not live plant readings.
- Actual admitted graph-bound scope/floor route caps remain present; the separate continuation witness preserves stripes and exact picks through 16 camera draws, with only the initial status-table upload and zero resources after disposal.
- Ordered-opacity GPU oracle: **17 cases each at DPR1 and DPR2**, actual 4-sample native target. Shared silhouette witnesses have zero failures and zero maximum error; mixed opaque/fractional source ownership, cyclic order, authored lines, offscreen cohort basis, legacy Plan depth, zero-opacity reveal, warm sliders, GL restoration and disposal pass.

The reviewer inspected both original/native Plan images and All/operating/lower native Map images. They retain the original drawing's architectural and machinery detail class. They are not asserted to be identical images: the current model has additional graph-linked routes, camera fits differ, the source-derived section inset differs, and the original operating SVG shows doors that the original 3D source assigns only to ground level. The current source does not invent upper-floor doors for a pixel match.

## Preserved test refusal

The first Plan stream-reference attempt failed closed before Chrome because its exact string guard no longer matched the production painter's moved compilation boundary. `failed-singleton-guard.log` is retained. Test-only commit `4151fa9cb17236a20580c4dcf22ad70fa840112d` changes only the guard and substitution point:

```ts
// Actual retained production helper:
stream = compilePhysicalPlanPaint(primitives, objectRoster(scene), physicalPlanPath)
// Independent singleton ordered reference:
stream = primitives.flatMap(primitive => compilePhysicalPlanPaint([primitive], objectRoster(scene), physicalPlanPath))
```

The guard requires exactly one match. No fallback, different paint rule, culling policy, tolerance or source selection was introduced. Original-sheet images are a separate visual comparison; the zero-pixel test compares batched native commands against native singleton commands only.

## Reproduction

From `apps/world` at the tested production tree plus the guard-only fixture commit, run these serially with no other browser measurement active:

```sh
bun scripts/physical-layout/plan-picking-probe.ts /absolute/output/native-ink
LEITBILD_OPACITY_PROBE_DIR=/absolute/output/opacity bun scripts/physical-layout/opacity-probe.ts
LEITBILD_PLAN_RASTER_DIR=/absolute/output/plan LEITBILD_ORIGINAL_PLAN_DIR="$PWD/scripts/physical-layout/evidence/final-quality-20261027/original-reference" bun scripts/physical-layout/plan-raster-comparison-probe.ts
LEITBILD_PHYSICAL_COMPARISON_DIR=/absolute/output/native-3d LEITBILD_PHYSICAL_COMPARISON_DPR=1 bun scripts/physical-layout/original-native-comparison-probe.ts
```

`source-manifest.json` hashes the production files, exact fixtures, original reference SVGs and retained artifacts. `ordered-opacity/executed-fixture.js.gz` preserves the actual executed GPU bundle. The comparison receipt's dirty state names only the guard fixture being committed afterward; production files remained exact. Raw external research output is under `draw-stack-audit-20261027/final-quality-2a2755715/`.

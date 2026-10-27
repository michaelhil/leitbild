# Exact native visibility-index qualification

Baseline production: `2a2755715162fc2335cf958fc08c14eebb0322f3`. Candidate production: **`a8db5f21e6e900887c900f04ef4d433389ae15ca`**. Test-only fixture commit: `b909e889df217beee92300eed0325a3de3994d3a`.

The candidate uses current-run union element buffers to avoid vertex work for mesh rows discarded by every instance. It retains original vertex and owner ordinals, original contiguous instance runs, native triangle/line primitives, face-before-line order and each instance's actual Float32 owner table. This record qualifies graphics/resource equivalence only; actual product performance is measured separately.

## Independent reference

The runner bundles the frozen2a backend **and its runtime imports from the frozen reference tree**, separately from the candidate backend. It refuses any production `src` diff in the reference tree. Both receive the exact same prepared buffers and owner metadata, and draw through the same native multisampled target. There is no expanded stroke, shadow backend implementation, altered pixel tolerance or source simplification. The compressed actual executed bundles and all file hashes are retained.

An A/A control first compares frozen2a with itself. The final A/B comparison uses the actual combineda8 source, not an approximate standalone algorithm.

## Results

- **27 cases at each of DPR1 and DPR2**, A/A and A/B both pass. All paired pixel comparisons have **zero differing pixels**, using the actual four-sample target.
- All eight visibility subsets of a three-mesh authored fixture; different contiguous instance masks; A1/B/A2 placement runs; clipped/offscreen native lines; status contours, highlight occurrence/colour, palette changes; Float32 alpha rounding; zero opacity and global fractional-architecture handoff.
- Warm camera-only change: owner uploads stay **15→15**, visibility uploads stay **16→16**, index allocation stays **192→192 bytes**, in each DPR run. No index rebuild/upload is hidden behind the stable geometry counter.
- Withdrawing all current runs: active ordinary index bytes become **64→0**. The remaining **96 CPU bytes** are the cached assets' immutable range arrays, not retained active masks. After full disposal, ordinary GPU buffers/programs/textures, index bytes and CPU range/mask bytes are all **zero**.
- The existing independent ordered-opacity oracle also passes **17 cases at each DPR directly against combineda8**, preserving shared MSAA silhouettes, original lighting, cyclic/global source ordering, authored strokes, zero-opacity picks, host GL state and disposal.

The byte figures above describe the small controlled fixture. They are not the full PWR working set, a resource budget or a production limit.

The earlier 25-case paired run and eb3 candidate pass remain in external research. The final 27-case version adds explicit visibility-upload/index-byte and withdrawn-run resource assertions. The change is in test coverage only, with no production changes between these final assertions.

## Reproduction

From `apps/world` in the fixture tree, retain a separate production reference checkout at2a and run:

```sh
LEITBILD_VISIBLE_INDEX_REFERENCE_ROOT=/absolute/frozen2a/apps/world LEITBILD_VISIBLE_INDEX_RENDERER_ROOT=/absolute/candidate/apps/world LEITBILD_VISIBLE_INDEX_EXPECT_INDICES=1 LEITBILD_VISIBLE_INDEX_PROBE_DIR=/absolute/output bun scripts/physical-layout/visible-index-probe.ts
LEITBILD_OPACITY_RENDERER_ROOT=/absolute/candidate/apps/world LEITBILD_OPACITY_PROBE_DIR=/absolute/output-ordered bun scripts/physical-layout/opacity-probe.ts
```

For the A/A control use the frozen2a checkout as both roots and omit `LEITBILD_VISIBLE_INDEX_EXPECT_INDICES`; that backend has no visibility-index counter. Candidate A/B mode requires actual index counters and asserts their lifetime. Run serially with no other browser measurement active. Receipts contain exact candidate/reference source hashes, fixture/bundle hashes, raw pixels statistics and resource observations.

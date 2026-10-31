# Plan ink candidate and empty-footprint qualification

The two changes reduce avoidable Plan interaction work without changing the architectural drawing, resolution, native Canvas ink predicates, status visibility policy, or picking order. They add no count limits, delayed detail, alternate renderer, or approximation of the final hit shape. Full-product RAF and cold-loading measurements are qualified separately; native predicate counts are not a frame-rate claim.

## Individual candidate bounds

The shared spatial tree visits every member of a matching leaf. Previously the Plan picker treated each member as a candidate even when its own conservative bounds missed the padded point query. It now checks each member with the same bounds-overlap helper and the same `entry, query` orientation before calling the unchanged native stroke, fill, hatch, or glyph oracle. Painter order and device-pixel padding remain unchanged.

The browser gate compares the frozen previous picker, current picker, and brute native result for **52,500 dense grid queries**, plus **114 named native ink cases** across DPR1 and DPR2. Cases cover curves, holes, rotated/dashed ink, glyphs, clipping, continuation paths, blockers, layer filtering, and zero-opacity architecture. Every result matches. Per DPR, native `isPointInStroke` calls fall from **11,314 to 3,523**; fill and glyph calls stay unchanged. These are measured test-scene call counts, not estimates for every plant/camera.

## Occurrences with no Plan ink

Annotation projection asks for footprints of real 3D occurrences that may have no drawing primitive on the selected Plan floor. The old missing-geometry path built or revisited the camera-sensitive text index and filtered all its entries for each such occurrence. The command index now records immutable text-owner membership. An owner with neither geometry nor text returns and retains `null` in the existing footprint map without visiting glyph metrics.

This absence belongs to the retained command-stream identity, which changes with source, floor, layer, or scope selection. It is not a cross-delivery or all-visited cache. Text-only owners still compute footprints through the current affine transform, DPR, font family, and font-loading revision. Geometry-only footprint caching is unchanged. A source replacement can introduce a previously absent owner.

The additional native browser case checks three rotated/scaled camera frames, text-only footprints against the previous implementation, and replacement-source admission. Missing-owner `measureText` calls fall from **3 to 0** per DPR. Both DPRs pass; the earlier 57 named cases per DPR and all grid comparisons still pass. The DPR1 and DPR2 screenshot hashes are identical between the bounds-only and bounds-plus-absence gates.

## Reproduction and evidence

From `apps/world`, run `bun scripts/physical-layout/plan-picking-probe.ts /absolute/output/path`. The probe uses the production Plan painter and picker in native Chromium Canvas2D; its scene and frozen previous implementation are test-only. It contacts no production Run or API.

[receipt.json](receipt.json) records source hashes, exact call counts, and SHA-256 manifests of the retained raw receipts, screenshots, and Chrome logs. Raw gates are preserved under `/Users/hilde/Documents/ChatGPT/plant-layout-research-20261025/draw-stack-audit-20261028/plan-entry-bounds-20261028/` and `plan-entry-bounds-absence-20261028/`. No full-product latency, interaction RAF, or TypeScript-check result is inferred from these native gates.

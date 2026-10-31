# Original architectural quality restoration: final visual qualification

Both browser probes ran against clean commit `17cc5022987f32ecfa3cf2e90ffb3dcf25a479d9`, after final source-retention admission. The admitted unit Design is `b4458fe4ae078623b6b8f426950b34627a49844ca5fc83f2c2bf970aa1a5da82`; its delivered scene has 744 objects and SHA-256 `6d61847305d335d223e4b38016a51b4699f04bc2815b149e6110fd4c863edb09`. Full receipts retain source/module hashes, actual camera poses, exact viewport sizes, layer states, controlled status inputs and GL resource disposal. These are functional and visual checks, not performance measurements.

## Native 3D

[native-3d/receipt.json](native-3d/receipt.json) passed. The original reference uses the frozen 23 October source and its actual natural per-floor camera. The current panel uses the real MapLibre camera, admitted R4 source and production native controller/preparer/renderer. There is no reflected comparison matrix.

- [Both floors](native-3d/all.png)
- [Operating deck](native-3d/operating.png)
- [Condenser and pump floor](native-3d/lower.png)
- [Controlled alarm contours](native-3d/operating-status.png)
- [Actual admitted scope cut](native-3d/actual-scope-cap.png), graph connection `feedwater-tank-to-main-feedwater-pump-a`
- [Actual admitted floor cut](native-3d/actual-floor-cap.png), graph connection `turbine-stop-valve-to-turbine`
- [Controlled cap pixel witness](native-3d/scope-cap.png)

Independent visual inspection confirms the original casing shapes, ribs, bolts, bearings, foundations, windows, steel framing, stairs, crane and work-area styling remain credible and detailed. Alarms preserve those authored solid materials and use contours; the existing owner-qualified badge remains available. Scope/floor cuts close at their actual intersection planes with material hatching. The controlled witness survives sixteen subpixel perspective pans with unchanged solid pixels, the same graph pick, one geometry upload and no GL error or leaked handles.

The native map uses its geographic context instead of the standalone reference's architectural ground grid. Camera framing differs through actual per-floor Home intents, and the full source adds graph-owned routes/valves and architectural details. These differences are recorded, not concealed with a reflected view or by deleting source geometry.

## Native Plan

[native-plan/receipt.json](native-plan/receipt.json) passed all 36 exact raster comparisons: both floors, utility/work-area toggles, controlled status on/off, and Home/pan/rotation. Every RGBA pixel equals an independently bundled ordered singleton-command reference; the permitted difference is zero. Text, hatches, alpha, clipping, contours and complete source detail remain in the same production painter.

- [Operating deck: original sheet and native Plan](native-plan/operating-original-native.png)
- [Lower floor: original sheet and native Plan](native-plan/lower-original-native.png)

These side-by-side sheets use equal metre scale and complete original sheet extent. Utilities are hidden in both: the frozen original SVG has its utilities group `display:none`; the native baseline hides `utility-routes`. The source-derived A–A level relationship now uses architectural exhausts, neck hatching, condenser ribs and supports. The original 2D sheet depicts operating-level doors which its frozen 3D source assigns only to ground level; the retained physical model does not invent upper doors to conceal that discrepancy. The product's map UI supplies its own scope, level, status and scale context rather than printing the original standalone sheet's title block.

The first batched paint stream failed this exact gate. Isolated source batches demonstrated different antialias coverage for close mullions, and small native raster quantization differences even for separated paths. The final stream preserves one submission per source primitive while retaining path caching, selection caching, scalar culling and incremental Canvas state. The failed gate was not relaxed; performance is qualified separately on the final combined product.

## Source and routing checks

The integration retains explicit architectural source, derived Plan drafting and physical solids, graph correspondence, source dependencies and compiler identity. It does not replace the source with screenshots or decorative generic primitives. The new routing sweep uses actual circular fillets, analytic tangents, parallel-transport frames and a radius-derived outer-surface chord budget. All 152 accepted current-unit routes construct with finite positions and unit normals; accepted source control points remain unchanged. Runtime delivery validates accepted routes and never runs authoring A* on cold load. Scope clipping is a derived inspection representation with actual graph identity and continuation marks, not a mutation of physical source.

Reproduce with the two scripts documented in `tests/browser/physical-scene/README.md`. Visual comparison requires independent inspection in addition to the automated technical receipt.

# Physical rendering closure: final 27 October qualification

Production source: `d8ebc139f35399d8ae99dc10b241e9c14d488b96`; source tree `61e2024817edd52e1177a02e92481610dbf68f02`. All source-grounded final
controls pass on the recorded Chrome/M2 profile. Production module hashes in
`final-manifest.json` are verified against that exact Git source.

| Actual fixture | DPR | Phases | Interior observations | Result |
| --- | --- | --- | --- | --- |
| yard | 1 | 8 | 5,876 | PASS |
| yard | 2 | 8 | 6,812 | PASS |
| unit-r2 | 1 | 12 | 6,776 | PASS |
| unit-r2 | 2 | 12 | 6,780 | PASS |
| gap-r2 | 1 | 4 | 220 | PASS |
| gap-r2 | 2 | 4 | 220 | PASS |

Every qualified temporal sample retains the correct painted material/physical
face and required exact occurrence pick, with zero winner flips. The actual
switchyard top/underside regression covers both MapLibre and Canvas, wide site
and yard views, thirteen nearby pan/zoom/tilt poses, and solid-only plus normal
strokes. Retained r2 unit controls additionally retain exposed steel and Plan
equipment; the separated parking-paint control retains a full device-pixel
interior margin. No arbitrary whole-image motion difference is a pass criterion.

The final GL receipt passes actual batching material/pick order, host
colour/depth/stencil sentinels, state restoration, status without geometry
reupload, twenty mount/disposal cycles and twenty style cycles, context restoration, gestures
and operational Deck picking. GL and state error lists are empty. Both yard
hosts release all owned physical buffers/programs/textures/targets after close.

## Fundamental corrections

The real yard is a 300 × 225 m, 60 mm thick slab. Forward 24-bit depth in the wide
Canvas camera quantized top and underside together. The shared owned float32
reversed-depth pass resolves actual separated surfaces without physical Z
offsets, polygon offsets, face removal or count caps. Both hosts use their
jointly supported colour/float-depth MSAA count(four on the reference GPU).
The complete target costs 47,329,920 bytes at 1440 × 913 CSS / DPR 1 and 189,319,680
bytes at DPR 2; it is released after use. These are typed owned target counters,
not total browser memory.

The original illustration's lighting is restored in Z-up, and operational
tint receives physical shading so casings and ribs retain form. The source
restores window openings, framing, crane/shaft/bearings, stairs and curbs at
each actual floor. Roof structure and utilities are retained as optional
facets. A declared hall+annex area and authored inspection pose replace
accidental hall-only framing; surrounding-building context is a view option.

The common camera solves all eight padded frustum-corner constraints, including
asymmetric UI padding and actual host near clipping. Native Map elevation had
been lost through both ground clamping and an instantaneous `easeTo` path that
ignores elevation. Public `jumpTo` and scoped camera ownership now preserve it.
Actual port tests validate wide/narrow cameras, native padding, authored target,
host pitch capabilities and suspension/Plan/disposal state restoration.

Plan annotation projection had rebuilt the camera and rescanned scene bounds
for every point. A camera/resize-revision ground X/Y/W snapshot now shares that
work without caching the full matrix or changing wheel cursor anchoring.
Independent actual-product causal profiling measured site Plan p95 from 66.6 ms
to 16.8 ms with the same source, geometry and text inventory. The final product
qualification separately passes 13 paused/playing/Plan/3D/floor-return windows
at each DPR 1/2, all p95 around 16.7–16.8 ms, zero long tasks, and required readable
upright room labels. Its receipts are maintained in the sibling product report.

## Visual evidence and boundaries

`images/native-product.png` is the actual accepted native product view.
`images/all-original.png`, `all-original-through-current.png` and
`all-r3-current.png` isolate drawing and source detail at a controlled legacy
projection; the operating-floor equivalents and labelled alarm frame are
included. The legacy Y/Z swap is a reflection (det −1). It does **not** prove
native Home pose or machinery screen-order equivalence. The admitted source
and native 139.893° vantage remain intact and are judged on actual product
appearance. A complete physical-source normalization was not disguised as a
presentation change.

The current Map feature is an architectural colour overlay on flat vector
geography. It does not share depth with native terrain/other 3D scenery. A
rejected depth-only host compositor passed opaque controls but lost 47/107 MSAA
edge pixels; the failure is retained in `rejected-host-depth.summary.json`.
Future terrain integration also needs a vertical datum, host-aware picking and
sample-aware depth integration. The failed native-camera controls are retained
separately rather than hidden by an offset.

The admitted r3 unit and campus pins are listed in `final-manifest.json`.
Existing user Runs retain their own source; the release exposes a fresh r3 Run
through published capabilities instead of hot-swapping retained layouts.
This qualification covers the recorded device, fixtures and scales; full
product runtime, owned resource closure and source-grounded pixel/pick proofs
are separate complementary evidence.

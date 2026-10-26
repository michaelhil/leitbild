# Real-gap temporal GPU control

Run `bun scripts/physical-layout/near-gap-probe.ts` from `apps/world`. Set
`LEITBILD_PHYSICAL_PROBE_SOURCE_ROOT` to a frozen `apps/world` source checkout,
and `LEITBILD_PHYSICAL_PROBE_DPR=2` for a separate actual DPR 2 run. The renderer
always comes from this script's checkout. This creates an isolated temporary
headless Chrome profile and loopback server; neither uses production APIs or the
user's browser, and both stop in `finally`.

This bounded control loads the actual retained campus Design and tracks one
parking marking above its actual pavement. The source's marking bottom is 12 mm
above the pavement and its top is 30 mm above it. These are genuinely separated
parallel faces, so a correction for exact coplanar ties must not hide a failure.
No source, physical offset, camera projection or depth state is modified.

Both real viewports focus the marking occurrence using their production camera.
Five top-face points are tracked through eleven nearby bearing/pitch/zoom poses.
The actual uploaded Float32 instance matrix projects each point to its actual
device pixel centre. Samples must be at least one full device pixel inside all
four projected edges, with the physical top in front of the pavement. The GPU's
blue marking fill and production CPU's exact occurrence pick must agree for all
55 samples per phase. Test-only blue/red roles distinguish the two actual
surfaces; green identifies unrelated equipment. The same phases run with normal
feature strokes and with `LINES` draws suppressed to rule out edge overlays.

Receipts retain source/fixture hashes and renderer/source commits, camera poses,
uploaded matrices, near/far estimates, actual GPU/depth/MSAA/DPR, per-point
pixels, margins, projected depth separation and picks. A static image or total
image differences while moving the camera cannot pass this test. No successful
result qualifies arbitrary smaller gaps, arbitrary hardware or untested scales.

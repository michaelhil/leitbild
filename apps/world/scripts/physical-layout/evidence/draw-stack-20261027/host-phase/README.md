# Native MapLibre phase boundary review

The installed MapLibre6.0.0-11 `CustomLayerInterface` assigns texture work to `prerender` and direct drawing into the main framebuffer to `render`. The [source receipt](contract-review.json) records the installed version, lockfile and source hashes. The product can use these public callbacks without importing the host's private implementation.

The source audit confirms the offscreen loop runs before ordinary main-frame drawing. `drawCustom` marks tracked state dirty and reapplies base state after either custom callback. After all offscreen work, the painter sets its main viewport and framebuffer. The final physical composite should therefore draw into the host target currently bound at its actual layer position, without querying and restoring a borrowed framebuffer around the offscreen transaction.

This contract does not permit unspecified incoming GLstate assumptions. Owned texture work establishes its framebuffer, viewport, draw state, VAO, samplers and upload dependencies. State outside MapLibre's tracking, including pixel unpack buffers, rasterizer discard and sample coverage, needs explicit neutral setup. Empty/error/lost frames must not composite the prior source image. Meshless Plan must still update the exact frame used by picking and projection.

The generic borrowed renderer keeps full state capture/restore. This source review does not qualify new pixels, resource lifecycle or speed; the separate native phase oracle and actual built-app windows must do that. No raster-disjoint batching or assumed universal pixel-error certificate is adopted by this boundary change.

## Built-app checkpoint

The [b7 checkpoint](b7-checkpoint.json) preserves actual built-app measurements. Ordinary full Live ON site3D passes at16.8 ms p95 paused/playing on DPR1. Whole-site fractional remains a severe failure:749.9/716.5 ms p95, while the scoped room passes16.7/16.8 ms. The phase/API correction therefore does not close the full-site performance gate.

The new profile no longer shows native getParameter as a hot function. Initial Deckmousedown readPixels is20.38 ms and postrelease hover2.57 ms. Mesh-subset acceleration reconstruction, architecture owner-row work, traversal and native/driver intervals remain. GPUqueries record about2,045 ordered draws per render. ScriptDuration and ThreadTime deltas differ materially, so CPUarithmetic samples alone cannot explain the stalls. Actual native call walltime is the next diagnostic; no utilization claim is inferred from unassigned `(program)` samples.

## Fractional controls withdrawn

The [9b decision receipt](9b-fractional-decision.json) preserves failed full-site Live ON/OFF windows and the bounded native-call diagnostic. Live OFF did not restore the frame budget. It retained the same starting physical matrices and opacity, and actual ordered render counts are reported separately from RAF frames.

Two MapLibre line-program compilation-status queries consumed1,858.4 ms of the1,976.2 ms measured native GLwalltime; the largest was1,745.3 ms. In contrast,16,421 actual ordered draw submissions totaled4.9 ms in nativecallwalltime. These timings include possible driver waits. The diagnostic also records memorypressure rising fromlevel2 to4, free metric19% to5%, and wired pages growing from564,826 to781,249 (16KiB pages) over its before/after interval. This supports a pressure/driver interaction as an open cause, not a demonstrated arithmetic fix or blame on unrelated apps.

Per the user's steering, fractional transparency is withdrawn from production controls for this release. Opaque architecture and inspection cutaway remain. The dormant research backend and its quality evidence are retained; no shader, native-line or ordering redesign is adopted to force a frame pass.

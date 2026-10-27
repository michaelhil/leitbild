# Native MapLibre phase boundary review

The installed MapLibre6.0.0-11 `CustomLayerInterface` assigns texture work to `prerender` and direct drawing into the main framebuffer to `render`. The [source receipt](contract-review.json) records the installed version, lockfile and source hashes. The product can use these public callbacks without importing the host's private implementation.

The source audit confirms the offscreen loop runs before ordinary main-frame drawing. `drawCustom` marks tracked state dirty and reapplies base state after either custom callback. After all offscreen work, the painter sets its main viewport and framebuffer. The final physical composite should therefore draw into the host target currently bound at its actual layer position, without querying and restoring a borrowed framebuffer around the offscreen transaction.

This contract does not permit unspecified incoming GLstate assumptions. Owned texture work establishes its framebuffer, viewport, draw state, VAO, samplers and upload dependencies. State outside MapLibre's tracking, including pixel unpack buffers, rasterizer discard and sample coverage, needs explicit neutral setup. Empty/error/lost frames must not composite the prior source image. Meshless Plan must still update the exact frame used by picking and projection.

The generic borrowed renderer keeps full state capture/restore. This source review does not qualify new pixels, resource lifecycle or speed; the separate native phase oracle and actual built-app windows must do that. No raster-disjoint batching or assumed universal pixel-error certificate is adopted by this boundary change.

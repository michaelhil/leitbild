# Physical scene GPU integration proof

From `apps/world`, run `bun run scripts/physical-layout/browser-probe.ts` on macOS with Google Chrome installed. The command builds these test-only sources into a temporary directory, serves a loopback-only test app, starts a separate temporary Chrome profile and closes it after collecting evidence. It never opens the user's browser or contacts production. `LEITBILD_PHYSICAL_SCENE_PROBE_DIR` optionally chooses the evidence directory.

The default tests the exact retained turbine-island Design. Set `LEITBILD_PHYSICAL_SCENE_PROBE_DESIGN=full-unit` to test the admitted complete PWR Design, including its source-derived native building overview and the transition to ready detail. This second mode requires real coarse polygons without additional detail loads at regional scale and immediate coarse removal when the interior becomes ready. The receipt records the selected exact Design reference; the two scopes must not be confused.

The app uses the production native scene compiler and renderer, the actual retained current-PWR source admitted through the real Scenario compiler, MapLibre and the production operational Deck layer factory with a compiled PWR owner presentation. The separate Deck canvas and native operational zone remain present while physical geometry renders. No trial renderer is imported. The diagnostic style has empty ground rather than PMTiles; full product tiles, inputs, faceplates and live Run semantics require separate application checks.

The receipt records source hashes, actual browser/GPU/viewport/AA, shared GL state comparison, preceding color/depth/stencil sentinels, triangle picking, distinct floor fragments, status-only pixel change without geometry upload, twenty mount/dispose cycles, twenty full style replacements and one forced context restoration. Every retained disposal checks actual WebGL buffer/program handles after deletion. A deliberate shared-buffer clear must be detected. A 350 ms stationary observation after 500 ms recovery quiescence includes repeated identical status refreshes. The final 638×720 viewport verifies both fitted plans and all eight corners of the real 3D source volume. The 3D camera uses a conservative volume sphere and public MapLibre FOV/camera APIs, rather than pretending a flat footprint fits its height. This is one desktop profile, not a fleet performance or total browser/driver memory qualification.

Shader status changes in this test are controlled test inputs. They are never production plant status. Saved PNGs include diagnostic sentinel rectangles and an explicit test banner.

## Original-versus-native visual comparison

Run `bun run scripts/physical-layout/original-native-comparison-probe.ts` to capture
the frozen 23 October original beside the current admitted source in the real
MapLibre viewport. Both panels have equal CSS dimensions. The original uses its
actual All/Operating/Lower camera presets; the map uses the authored inspection
area's Home. The receipt records both poses, dimensions, source identity and
module hashes. It never reflects a camera matrix to conceal a coordinate-frame
difference. `LEITBILD_PHYSICAL_COMPARISON_DIR` selects the output directory and
`LEITBILD_PHYSICAL_COMPARISON_DPR` selects the test DPR.

Six PNGs cover all three level selections with and without a controlled status
accent. An independent GPU witness requires unchanged solid interior pixels,
changed contours, unchanged geometry-upload count and actual deleted resources
in both Plan and 3D. The technical pass certifies these checks; visual acceptance
still requires inspecting the side-by-side images and the full product UI.

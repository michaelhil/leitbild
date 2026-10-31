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

## Native Plan raster qualification

Run `LEITBILD_ORIGINAL_PLAN_DIR=/absolute/path/to/turbine-hall-trial bun run scripts/physical-layout/plan-raster-comparison-probe.ts`. `LEITBILD_PLAN_RASTER_DIR` chooses its evidence directory. The source is the current admitted Halden scenario; the original SVG sheets are the retained 23 October architectural browser trial, whose hashes enter the receipt.

The test bundles the production Canvas painter twice. Its ordered reference replaces only the retained stream compilation with one source primitive per command; this change exists in the test bundler and has no production flag. The inert reference port throws if it is used outside this bundle. Both versions retain the same clipping, labels, hatches, material palette, status, transforms and layer selection. Thirty-six cases compare every RGBA byte across both floors, layer toggles, controlled status, and Home/pan/rotation. The permitted difference is zero. A technical failure remains a failure even if its image looks close. Isolated multi-path batches are also tested, recording source identities and bounds so that native antialias coverage can be distinguished from lost source features.

The two original/native sheet images use the same useful metre scale and complete original sheet extent. This specific reference fixture accounts for the retained original unit authoring origin `[44.4,26,0]` and its canonical northward coordinate conversion; it is not a product camera policy. Visual inspection must separately assess architectural detail, source additions and drawing presentation. Byte equality of the two native painters alone cannot certify the original's visual quality.

## Preparation CPU attribution and exact geometry guard

`LEITBILD_PREPARATION_PROFILE_DIR=/absolute/evidence/path bun run scripts/physical-layout/preparation-phase-probe.ts` loads the actual admitted scenario and profiles one occurrence of each exact geometry family. It separates mesh construction, scope clipping, surface annotations, coplanar ownership, picking hierarchy construction and render packing. The receipt records source hashes and exact ordered geometry/material/conditional-owner/picking-array hashes. Set `LEITBILD_PREPARATION_BASELINE_RECEIPT` to a retained receipt to refuse any byte change while evaluating a performance-only implementation. `LEITBILD_PREPARATION_PROFILE_LEVEL` selects an authored floor instead of All.

Stage timings are CPU attribution, not final browser cold-load or frame-performance qualification. Use a quiet paired interval for timing comparisons. The overlap workload queries every face, so its SAH builder considers transverse axes in packed presorted storage; sparse pointer-ray picking retains the existing faster builder. Both preserve source ordering and the same geometric predicates. No triangle, component or scene admission count is capped.

## Ownership eligibility correction

`LEITBILD_OWNERSHIP_COMPARISON_DIR=/absolute/evidence/path bun run scripts/physical-layout/ownership-eligibility-comparison-probe.ts` bundles the committed cap-fixed103fa preparation reference and compares it with current geometry using the same controlled GL context and the realized public MapLibre camera matrix. The second panel remains the actual native map. It compares four affected views with controlled status off/on, rendered pixels, material areas/normal integrals and paired graph picks. The criterion remains zero changed controlled pixels; independent canvas/map default-framebuffer resolve differences are diagnostic only and have an identical-code control. `LEITBILD_OWNERSHIP_REFERENCE` selects another committed reference for that control.

`LEITBILD_PREPARATION_PROFILE_MATRIX=all` extends the CPU exact-byte guard to authored unit/campus floors, full/cut/exploded views, native Plan picks and the turbine area. `LEITBILD_PREPARATION_PROFILE_FAMILY=unit` or `campus` permits independent functional jobs. By default every mesh layer is explicitly visible so hidden utility routes cannot conceal cap failures. Set `LEITBILD_PREPARATION_PROFILE_VISIBLE_LAYERS=default` only for a separately labelled default-layer attribution run. Matrix timings taken concurrently are not performance evidence.

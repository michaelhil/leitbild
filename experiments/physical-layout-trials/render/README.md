# Native and Babylon map rendering trial

24 October 2026. This is an executed offline/browser experiment, not a registered Pack, production viewer or live-data source. The authoring-source decision is independent of this rendering decision.

## Result and recommendation

Both backends pass the exercised shared-context, visual, visibility, state-only update and lifecycle envelope. Their matched canvas pixels are byte-identical at the frozen lower-level correctness pose. Performance is meaningful parity on the one measured Apple M2/Chrome 155 profile: native p95 total frame intervals 17.8/18.4/18.1 ms, Babylon 17.9/18.0/18.1 ms for the accepted slice, 500 repeated shaped pumps and four-unit campus respectively. These are 90-frame runs, not a statistical hardware fleet result.

**Recommend native WebGL2 for the bounded finite-geometry slice.** Babylon adds 937,491 raw JavaScript bytes in the actual lazy path (226,870 bytes if the same loaded modules were gzip-served). The trial serves uncompressed assets, so gzip is a build-size estimate, not measured network transfer. Babylon supplies buffer/geometry ownership, material and scene traversal; however this envelope still needs the same map matrix, custom shader, shared-context guard, physical/view policy, CPU picking and lifecycle controller. It has not demonstrated a smaller coherent owned system for the required bounded feature. Native's recommendation follows equivalent tested behavior plus incremental cost and retained responsibilities, not source-line count or a claim that Babylon is intrinsically slower.

Babylon remains a viable qualified contender for this shared-context pair. Requirements for glTF loading, more elaborate materials, advanced scene tools or accelerated picking could change the maintenance balance; those capabilities were not qualified here and should not be credited as tested wins. The first production slice still needs its integrated Run/card/input/accessibility and device gates. This experiment does not authorize shipping two production renderers.

## Reproduce

From this directory with Bun 1.4.0:

```sh
bun install --frozen-lockfile
bun test
bunx tsc
bun run build
bun run server.ts
```

Keep that server running, then run `bun run probe-browser.ts` in another terminal, followed by `bun run finalize.ts`. The probe uses the installed macOS Google Chrome headless binary, creates a separate temporary profile, talks to its own CDP endpoint and terminates that browser. It does not operate the user's normal browser session. Rebuilds require restarting the preview server because it freezes the served build-file allowlist at startup. No server deploy or production dependency was added.

Open `http://127.0.0.1:43124/` to compare the backends and levels. `window.trial` exposes the same real correctness, benchmark, lifecycle, style and context-recovery checks to an independent reviewer. The UI states that status is synthetic fixture data. It has no Run operations.

Read [final receipt](receipts/final-receipt.json), [native browser observations](receipts/native-headless.json), [Babylon observations](receipts/babylon-headless.json), [deliberate-clear controls](receipts/negative-controls.json) and [module build sizes](receipts/build-receipt.json). Screenshot captures are [native](receipts/native-headless.png) and [Babylon](receipts/babylon-headless.png). Exact source hashes and limits are included in the final receipt; peer source-authoring output is not substituted for these benchmark workloads.

## What was exercised

The exact local dependencies are MapLibre `6.0.0-11` and Babylon core `9.23.0`. Both use one map, camera and WebGL2 context, with no scene render loop. MapLibre requests frames. The scene uses the same local metres/Y-up adapter for the copied reference visualization, composed in float64 with the map matrix before GPU float32 conversion. New source-derived delivery enters in metres/Z-up and is converted once.

The shader, geometry, physical IDs, visible fragments and CPU triangle-reference picker are shared or equivalent. A pump behind an opaque upper slab is not pickable; selecting its level exposes it. Level separation is a display offset only. Native uses a cache of one interleaved GPU buffer per shared geometry; Babylon uses shared Geometry objects with separate position/normal/colour/index buffers. No ordinary/thin-instancing draw-call reduction is claimed: the 500 assembly fixture uses 500 visible draw instances in both paths.

The slice has 16 equipment occurrences, seven bound subjects and 42 visible scene objects after cutaway. It draws 33,828 triangles. The 500 fixture shares one actual 2,896-triangle shaped family (1,448,000 submitted triangles); the campus has four instances and one shared yard, 169 visible objects and 135,360 triangles. Neither is a completeness claim for a real nuclear site. Native reference fill and operational line/zone/icon overlays exercise fixed composition around the scene; the UI is an HTML overlay.

The GPU checks go beyond state equality: an earlier magenta color/depth marker survives, a farther blue overdraw is rejected, and an earlier stencil=7 region admits a yellow marker after the scene. Every captured state field is restored. Deliberately clearing shared color/depth/stencil fails those probes in both backends, demonstrating a meaningful negative control. No GL errors or state mismatches remain in the final receipt.

Both backends completed 20 mount/dispose cycles, 20 full-style replacements and one forced WebGL loss/restore. For every slice disposal the probe retains actual WebGL handles: 42 native buffers or 168 Babylon buffers, and one shader program. `gl.isBuffer` and `gl.isProgram` report zero still live after release. Estimated buffer payloads remain stable across recreations. This establishes owned geometry/program disposal, not zero total browser memory growth. Hidden buffers, driver allocations, staging memory and global MapLibre usage are outside the byte estimate.

Status-only synthetic changes update uniforms and do not upload static geometry. Idle rendering is zero during the measured 350 ms idle interval. No alarm latency, coherent live acquisition, process identity policy or operational status correctness is inferred from that check.

## Correction stage and retained failures

Initial receipts in `receipts/initial/` used an antialias option in the wrong MapLibre location; their actual reported context had AA=false. This was corrected to `canvasContextAttributes.antialias`, and the final matched recheck uses actual AA=true. Depth/stencil buffer probes, pixel hash and explicit native operational overlays were added during the same bounded checking stage.

The expanded style test exposed a real shared-lifecycle defect: full MapLibre style replacement removed registration without invoking this experiment's `onRemove`; simply re-registering leaked old owned resources. Both failures are retained in `receipts/style-failure/`. The controller now explicitly disposes its previous scene and instrumentation even when their old style registration has vanished. Final checks rerun both complete paths, including actual handle release; earlier success is not carried forward. Babylon's internal draw counter also needed an explicit diagnostic frame boundary because no independent Engine loop runs.

During development, serving an old build allowlist after a rebuild prevented a new Babylon chunk loading. Restarting the local server resolved this harness issue. The driver now refuses incomplete receipts and reports exceptions instead of recording a blank success. This is not a format/engine correctness failure or a production service change.

## Authoring-output preview contract

The viewer accepts `layout-trial-mesh` delivery: metres, Z-up, stable object identity, level identity and triangle positions/optional indices/colors. Validation rejects duplicate IDs, nonfinite positions and invalid indices. Place independently generated outputs at `imports/native.json` or `imports/ifc.json`; open `?scene=native&backend=native` or `?scene=ifc&backend=babylon`. These copied files are ignored and are not a new editing authority. Preserve their originating hash/revision in the source-quality receipt. Do not mistake reference geometry screenshots for saved-source reproduction.

Imported Cutaway is an explicit inspection policy: hide objects declared `roof` and clip objects declared `wall` at 1.1 m above their own source base. The view fragments are uncapped, drive the same picks and never rewrite source solids; Full walls restores the original solids. This is not a production Level View profile, arbitrary section solver, physical removal or checker representation. New/unknown level IDs remain selectable. Arbitrary multi-level imported separation remains outside this trial's qualified two-level reference envelope.

The coordinator observed a shared 638 px IAB limitation: initial/reset framing crops part of the hall and the toolbar covers the upper scene. The full comparison viewport is 1440×913 DPR1. No responsive production-layout claim is made. Root separately reviews actual IFC/native source-derived plans and solids.

## Maintenance and unqualified scope

Both paths retain map scene/controller lifecycle, high-precision matrix adaptation, visibility/view fragments, shared-context state guards, state/identity bindings and inspection. The native adapter owns shader compilation, explicit VAO/buffer upload/cache/draw/disposal. The Babylon adapter owns Engine/Scene setup, shader material and data conversion, mesh/geometry reuse, MapLibre-driven rendering and disposal; the library performs its internal scene/material/buffer work. Its presence does not remove the shared controller responsibilities or supply the source schema.

No constrained physical device, shaped WAN, full production tile/terrain/deck/Pack input stack, glTF importer, PBR/texture material, globe, arbitrary capped section, accelerated/hover picking latency, full CPU/GPU memory or 5,000-subject telemetry table was qualified. Fresh loopback page-ready observations are native-first then Babylon in one browser; they cannot establish a causal startup-speed ranking. Headless timing and concurrent authoring work also limit small performance comparisons.

Reference visual family/math/mesh/scene files were copied from trial commit `020941fcea1ad8079a53f5d0da0c4a6541d72e71`, with local imports only. This renderer worktree starts at the shared frozen input commit `c9a8273a29e13e338013c671e06f1fc605fb86f9`. Root discovered newer production code at `f9ffc3f8a2b1aec6718cadfd42845940af5476a0`; this experiment does not claim to include its full UI/integration behavior. No production code, wiki or server was edited by this agent.

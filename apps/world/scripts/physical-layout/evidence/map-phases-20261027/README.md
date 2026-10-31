# Native MapLibre phase equivalence

The complete frozen `30fb742e561481faac940e403fc21c44c8537a46` custom layer and its renderer imports are the reference. The candidate contains the `b7d8a9288` offscreen-prerender change. Its receipt HEAD is `c4282c1d6ee05c844bdbba7ac17066f7dfcc05d4`; `git diff b7d8a9288 c4282c1d6 -- apps/world/src` is empty.

All 12 candidate/reference comparisons pass with **zero differing bytes**: opaque and fractional architecture at three actual MapLibre poses, each at DPR 1 and 2. Both sides receive the same packed known geometry. Every fractional cell requires a nonempty cohort key, positive ordered geometry and index bytes, and positive actual ordered draw count (21–22 before capture). Opaque controls require zero ordered draws and no cohort. The installed Noto glyph artifact is identical by SHA-256; native MapLibre text, operational circle and registered icon remain visibly above the physical layer. These controlled colours are test data, not a plant-status proposal. Real admitted R5 visual quality has separate original/native evidence.

The accepted candidate also checks:

- Zero `getParameter` calls inside either warm physical callback. The reference makes 27 per render. Initial resource/shader capability work is outside this steady-state assertion.
- Physical colour/depth clears only an owned target during prerender. Render draws into its current host framebuffer without clearing or binding another target.
- A non-null host framebuffer and nonzero viewport origin, with viewport extent equal to prepared pixel extent. Pixels outside that viewport retain their previous values.
- Pick/palette/highlight invalidation between callbacks; empty and deliberately failed new preparation never composite old colour.
- An ink-only Plan updates its exact component pick without a GL draw or target clear.
- Context loss, actual map restoration to idle, and explicit public custom-layer reinstallation recover identical pixels. This is not a claim that a bare custom layer persists automatically through MapLibre's style reload.
- The generic borrowed renderer preserves a deliberately bound unpack PBO, nonzero row length/skip state, enabled rasterizer discard/sample coverage/alpha-to-coverage, coverage invert/value, and disabled DITHER. Real geometry is uploaded/drawn, the original state returns exactly, and GL error is zero.
- Warm geometry uploads and target allocations remain unchanged. Final physical buffers, programs and textures are released. Disposal between callbacks does not composite.

The error fixture is confined to tests. It first prepares real buffers, then deliberately throws from the entry reader, checks the reported error and verifies old colour/picks are refused.

`control-*.json` are frozen A/A receipts. `candidate-*.json` are the final strict receipts. `summary.json` includes phase records, exact source hashes and the executed browser-bundle hash. `executed-app.js.gz` preserves that bundle. Representative paired PNGs are included. This is a functional gate on one desktop browser/GPU profile; it contains no frame-rate, device-generality or WAN claim.

## Reproduction

Use a checkout whose complete `apps/world/src` is still frozen at 30fb as the reference. The runner refuses a reference with changed tracked source. From the World directory containing the fixture:

```sh
LEITBILD_MAP_PHASE_REFERENCE_ROOT=/absolute/frozen-30fb/apps/world \
LEITBILD_MAP_PHASE_CANDIDATE_ROOT=/absolute/candidate/apps/world \
LEITBILD_MAP_PHASE_EXPECT_SPLIT=1 \
LEITBILD_MAP_PHASE_GLYPH_URL=http://127.0.0.1:43148/map/fonts/Noto%20Sans%20Regular/0-255.pbf \
LEITBILD_MAP_PHASE_DIR=/absolute/output \
bun scripts/physical-layout/map-phase-probe.ts
```

The glyph artifact may instead be supplied explicitly with `LEITBILD_MAP_PHASE_GLYPH_FILE`. It is retained with a hash in each run. For A/A, point both roots at the frozen checkout and omit `EXPECT_SPLIT`. `SINGLE=1` is a diagnostic one-case selection; it is recorded and is not the full acceptance matrix.

## Retained rejected harness attempts

Raw attempts remain under the research `draw-stack-audit-20261027/map-phase/` directory:

- `control-aa`: the first DPR2 icon had not reached MapLibre idle. The accepted A/A waits for actual idle and detects visible glyph/icon pixels.
- `candidate-b7-live` and `debug-local-state`: manual test cleanup restored a saved texture binding after deleting that renderer-owned texture. This produced `INVALID_OPERATION` only at test restoration, after product callbacks and sampling were error-free. The debug aggregate initially omitted its newly added checkpoint errors and is **not accepted**, despite its aggregate `passed` field. The final gate asserts every checkpoint and restores before disposing.
- `final-b7`: the new context-loss test incorrectly assumed a bare custom layer survives a MapLibre style reload. Later local checks consequently had no layer. It is rejected.
- `final-b7-public-reinstall`: reinstall was attempted before the restored style had loaded. The driver failed with “Style is not done loading.” The final accepted run waits for actual map idle before public reinstallation.

The initial fixture and evidence commit `4c18674b1` called `setArchitectureBsp` before `map.addLayer`/`onAdd`; its optional forwarder had no renderer yet. Its six fractional-labelled comparisons are **withdrawn**; their aggregate pass was insufficient. Their raw receipts, summary and executed bundle are retained in `superseded-no-ordered-cohort/`, and all initial raw research output remains in place. The corrected fixture installs the layer first and enforces actual ordered-draw/cohort witnesses for every fractional cell, including A/A.

The accepted raw directory is `final-b7-complete`; corrected A/A is `control-aa-ordered-qualified`. These were test-lifecycle corrections; no candidate product code was changed during the oracle work.

# Final R3 actual-product qualification

Production source is frozen at `d8ebc139f35399d8ae99dc10b241e9c14d488b96`.
The exact admitted unit Design is `812180a4…`, campus `e0987eae…`, compiler
`96e82c37…`; complete identities and file hashes are in `r3-manifest.json` and
`r3-product-qualification.json`. This is the restored architectural R3 workload,
not another speedup comparison against the retained R2 model.

## Cold loading and view changes

The real local Host/World stack was stopped and restarted with its fresh paused
R3 Run before the frozen loading protocol. All fifteen actions passed with no
observer/GL errors, exceptions or pending jobs. Actual draws show four unit
instances and one campus instance.

| Observed checkpoint | Milliseconds |
| --- | ---: |
| Initial requested unit draw after opening the browser | 2148.4 |
| First actual draws of both complete source families | 2194.4 |
| Conservative completed-GPU upper bound for both families | 2257.7 |
| First operating-floor 3D action → matching draw / recorded fence | 316.6 / 327.4 |
| First uncut Stack → matching draw / recorded fence | 1044.1 / 1062.5 |
| First operating-floor Plan → matching draw / recorded fence | 218.0 / 231.9 |
| GC return to operating-floor Plan → matching draw / recorded fence | 18.5 / 31.9 |

Cold loading remains visible; these figures do not claim instant preparation.
The original frozen observer's first fence/readiness checkpoint is 2186.5 ms.
The campus preparation response arrived between the first unit draw and that
fence's check, while its actual draw occurred in the following frame. Therefore
2186.5 ms must not be described as completion of all site GPU work. The next
unchanged full-site action observes both families drawing before its fence;
its completed fence provides the conservative 2257.7 ms bound from the original
dispatch. Raw timestamps are retained, not rewritten to conceal this boundary.

## Both hosts, both display scales

Fresh Chrome profiles at DPR 1 and DPR 2 each passed thirteen four-second input
windows: full-site browser 3D and Plan, selected turbine hall 3D and Plan, map
3D and Plan, paused and playing, plus browser-return Plan. Every window has
p95 RAF intervals of 16.7–16.8 ms and zero long tasks. Public Run capabilities
drive actual local playback; selected-owner windows require fresh live data.
No drag opened a process window, and no product or observer exception occurred.

The Plan collection gate contains all five ready layouts and an actual drafting
backing. Readable room and returned-room Plan paint these eleven strings:

`HP`, `LP 1`, `LP 2`, `LP 3`, `GEN`, `EXC`, `MSR 1`, `MSR 2`, `TURBINE HALL`,
`88 m`, `36 m`.

The spy reads the actual Canvas2D transform at every text paint. Equipment and
room captions are horizontal; the vertical dimension is at −π/2. Every painted
caption stays within the upright half-turn. The room screenshots and raw paint
records remain in external research storage with hashes in the receipt. Small
whole-site footprints can legitimately reject their text by measured fit.

## Resource ownership

Both display scales observe the actual float32 depth target with four-sample
MSAA. At DPR 2 the dedicated surface is 2880 × 1742 pixels:

| Active dedicated backing | Bytes |
| --- | ---: |
| Float32 depth renderbuffer, MSAA 4 | 80,271,360 |
| Color renderbuffer, MSAA 4 | 80,271,360 |
| Resolved color texture | 20,067,840 |
| Plan Canvas2D RGBA lower bound | 20,067,840 |
| Sum of these observed backings while Plan is active | 200,678,400 |

DPR 1 uses one quarter of these bytes. The map has a narrower actual viewport;
its per-phase dimensions and storage are recorded separately. These numbers
exclude geometry/VBOs, prepared and source CPU arrays, worker/module heaps,
native/default MapLibre buffers, driver overhead and peak process memory.

Closing the dedicated host releases its owned targets; reopening it leaves no
map-owned physical target while the map is inactive. Navigating away leaves
zero physical source/preparation worker targets in CDP. Independent GL state,
pixel/pick, native camera and resource tests complement these actual-product
checks; these counters are not a whole-process leak proof.

## Reproduction and limits

The loading observer remains the same frozen one used for the controlled R2
pair. The R3 motion runner is test-only commit `e2a70b67c`, including actual
text-angle capture and public Home keyboard input. Final standalone World
TypeScript checking passes. The annotation spy's maximum reported overhead is
2.8 ms over a four-second window; other observer overhead is not fully isolated.

Commands, using the separately built frozen app and the exact local Run:

```sh
LEITBILD_LOADING_TESTED_COMMIT=d8ebc139f bun scripts/physical-layout/loading-product-probe.ts qa-run-r3-final.json output-loading
LEITBILD_LOADING_TESTED_COMMIT=d8ebc139f LEITBILD_PHYSICAL_PROBE_DPR=1 bun scripts/physical-layout/r3-product-probe.ts qa-run-r3-final.json output-dpr1
LEITBILD_LOADING_TESTED_COMMIT=d8ebc139f LEITBILD_PHYSICAL_PROBE_DPR=2 bun scripts/physical-layout/r3-product-probe.ts qa-run-r3-final.json output-dpr2
```

This is one device, Headless Chrome 156, eight actually reported logical CPUs,
real local services and read-only published vector/reference assets. It does
not qualify WAN conditions, constrained hardware or every future plant. RAF
intervals are not GPU execution durations or physical-monitor timestamps.
Normal product CI and release validation remain separate gates.

Earlier failed receipts are preserved separately: an overly broad site-text
precondition, an area-search DOM mounting race in the test, and an assumption
that the 3D-only Home button exists in Plan. They are not presented as passing
product runs. The successful final receipts come from complete fresh-profile
runs with all thirteen gates; no implementation or gate was changed during a
run. No saved Run state, retained source blob or credential is published here.

# Actual native Map Plan paint equivalence

The independently built supported app `793743c00e49d7578544bb4164b9077cde8e01d7`
and candidate `954af6cf2fcf5df924a6935780fde293b4049386` produce exactly the
same Canvas RGBA in all four captured cases: the complete five-layout site and
the turbine hall/feedwater annex operating floor, each at DPR 1 and 2.
`comparison.json` records zero differing bytes across 41,385,600 compared bytes,
identical actual affine paint transforms, identical text sequence, scope and
floor. Fonts had settled. There is no pixel tolerance, AA change or shared
candidate-function reference: the reference is the actual older built app.

The gate uses the same retained paused R5 Run, public Host View, scope, Plan,
floor, Live off and Home controls. It does not mutate Run physics, source,
graph, alarms, camera internals or production. Live is off so the drawing is
immutable for an exact comparison. Dynamic live/glyph behavior, rapidly
superseded intents and moving-camera performance have separate gates; this
receipt makes no performance or whole-lifecycle claim. The recorded paint
counts include startup and public actions and are not a frame-cadence measure.

The old app was captured and its Chrome closed before the server was rebuilt
once to the candidate; the same capture runner and arguments apart from source
reference/output directory then ran against that build. Both metadata files
retain the identical admitted unit/campus Design pins. Both candidate Chromes
were closed and the exclusive GPU/CPU slot released before the performance
agent started its paired qualification.

The PNGs and capture metadata are retained here, with SHA-256 in `manifest.json`.
The raw decoded Canvas rows remain in the research directory named by that
manifest. The comparator reads those decoded bytes independently rather than
comparing PNG compression. The full product candidate screenshots at DPR 1
show the actual native geographic map and its architectural Canvas.

Reproduce from `apps/world`, on an isolated paused loopback Run, preserving
the baseline build until the two baseline captures finish:

```sh
bun scripts/physical-layout/native-map-plan-paint-probe.ts \
  "$OWN_PAUSED_RUN_URL" /absolute/pair/baseline-dpr1 793743c00
LEITBILD_PHYSICAL_PROBE_DPR=2 bun scripts/physical-layout/native-map-plan-paint-probe.ts \
  "$OWN_PAUSED_RUN_URL" /absolute/pair/baseline-dpr2 793743c00
# Build and serve candidate, retaining the same Run and source pins.
bun scripts/physical-layout/native-map-plan-paint-probe.ts \
  "$OWN_PAUSED_RUN_URL" /absolute/pair/candidate-dpr1 954af6cf2
LEITBILD_PHYSICAL_PROBE_DPR=2 bun scripts/physical-layout/native-map-plan-paint-probe.ts \
  "$OWN_PAUSED_RUN_URL" /absolute/pair/candidate-dpr2 954af6cf2
bun scripts/physical-layout/native-map-plan-paint-compare.ts /absolute/pair
```

No production code is changed by this evidence commit. The parent already
checked the candidate World source (0 errors, 0 warnings) and its 48 focused
tests (261 assertions). No additional full check was started during the
exclusive performance window; the two CLI tools should be included in the
normal combined check.

# Actual R3 product qualification

From `apps/world`:

```sh
LEITBILD_LOADING_TESTED_COMMIT=<separately-built-frozen-app> \
LEITBILD_PHYSICAL_PROBE_DPR=2 \
bun scripts/physical-layout/r3-product-probe.ts qa-run-r3.json evidence-directory
```

The input names a fresh local R3 Run created through published Scenario start
and execution Capabilities. The runner refuses non-loopback URLs. Its only Run
commands change that explicit local Run between paused and playing. `finally`
attempts to pause it and always closes the isolated Chrome profile.

The existing `loading-product-probe.ts` remains the frozen before/after latency
observer. This runner separately qualifies actual R3 motion and drafting:
full-site 3D, full-site Plan with all five layouts ready, selected hall 3D/Plan,
both real hosts, paused/playing, and Plan after switching hosts. It follows
actual loading/owner evidence and two render scheduling frames instead of fixed
scope/floor helper settlement sleeps. Four-second input windows are an explicit
test workload; they are not production runtime limits. RAF intervals are not
GPU execution or physical-monitor presentation timestamps.

The test observer records actual `fillText` calls made by the drafting canvas,
their unique strings, active canvas backing dimensions and RGBA byte lower
bounds. This prevents a ready-state check passing while source labels are lost.
Font-dependent collision packing may legitimately hide some captions; the
receipt and screenshots permit inspection of the exact visible set.

Weak GL resource keys and primitive allocation metadata identify owned depth32F
targets, observed MSAA sample counts, color renderbuffers and resolve textures.
Storage accounting excludes driver overhead, temporary allocations, module
heaps, native default backbuffers and unrelated MapLibre storage. Closing the
dedicated host must release its targets; hiding the map must release map-owned
physical targets. Navigating away must remove physical-worker CDP targets.
Independent renderer lifecycle tests remain necessary for complete GL state
and disposal qualification.

The observer adds overhead. Annotation metadata time is reported; other callback
overhead is not separately attributed. Capture actual DPR, dimensions, hardware
and browser. Qualify R3 as its own detail profile; do not describe its timing as
the retained R2 optimization comparison.

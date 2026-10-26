# Coplanar face ownership: temporal GPU proof

Run from `apps/world` with Bun and local Google Chrome:

```sh
bun --no-env-file run scripts/physical-layout/flicker-probe.ts
LEITBILD_PHYSICAL_PROBE_DPR=2 bun --no-env-file run scripts/physical-layout/flicker-probe.ts
```

The command uses a temporary loopback app and isolated Chrome profile, loads the exact admitted current Unit 1 source through the Scenario compiler, then closes its own server/browser. It makes no production requests. `LEITBILD_PHYSICAL_PROBE_SOURCE_ROOT` can point at a frozen `apps/world` source checkout while a candidate renderer is tested. The receipt retains source hashes, Design identity and fixture digest; a compiler/source change must not be silently substituted for a renderer fix.

The real MapLibre and dedicated canvas viewports focus the turbine hall in Stack/all-floors. Diagnostic blue wall and red structural-steel colors expose ownership without changing geometry. Eleven nearby bearing/pitch/zoom poses track actual model-space points in the shared north wall/column front plane. A sample must lie at least one full device pixel inside both projected column sides. The oracle is the existing first-source surface ownership policy, with CPU picks recorded independently. Changes in arbitrary screen pixels while a camera moves are not treated as flicker evidence.

The test intercepts only `LINES` draws for a labelled solids-only control, then repeats normal strokes. A reproduction that persists without lines demonstrates solid-face competition. Above-wall points must retain the exposed column, preventing a false pass from removing all structural steel. Plan checks seven actually painted machinery tops and exact picks against a contrasting floor; they do not pretend an open clipped support has a generated cap. The normal room fit and a closer room view exercise the scale in the user's image. DPR 2 is a separate run, not a relabelled DPR 1 result.

The raw `receipt.json` includes all pixel samples, CPU identities and actual uploaded Float32 matrices. `summary.json` retains per-point material tracks, per-frame matrices/depth-range estimates, GPU/depth/AA/viewport facts and source identities without every raw coordinate. Both are executed data, not assertions copied from source code. A passing gate requires correct material ownership and exact picks for every sampled interior point, stable ownership across nearby poses, the positive controls and Plan controls. No production draw, scene, badge or ray-count cap is introduced.

This is one retained single-placement PWR fixture and one reference device; it does not qualify arbitrary models, hardware or overlapping separate placements. Actual app/UI, live owner semantics and visual acceptance remain separate tests. The diagnostic palette and suppressed-line control are test inputs, not proposed production appearance or production plant status.

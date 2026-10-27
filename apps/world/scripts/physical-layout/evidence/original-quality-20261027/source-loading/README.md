# Source validation duplicate-work audit

This records a small Pack adapter optimisation over the frozen R4 sources. It changes neither the native compiler closure nor source, bindings, applicability or Scenario pins. The full discriminated input parse and every retained source/binding/coverage/Design/applicability/presentation/geometry check remain required.

`compileRetainedPhysicalSource` previously parsed the complete source, then parsed the same known profile again before native compilation. The adapter now dispatches the already validated result. The existing shape-facts authority already emits its fixed fields in canonical order; hashing now serializes that unchanged output directly instead of recursively cloning and sorting every numeric array again. There is no custom rounding or hash engine.

The initial `stage-attribution.json` includes JIT, contention and GC variation. It identifies work but does not support a cold-product speed ratio. The controlled `hash-pair.json` uses identical compiled scenes, six alternating-order pairs per family, and pre-call collection. All twelve pairs are positive: unit median 103.3 → 93.4 ms; campus 43.1 → 36.4 ms. These are warmed CPU hash costs, not source-worker startup, end-to-end loading, network or GPU times. The removed duplicate parse separately took approximately 6–17 ms in attribution. This does not establish the two-second product goal; native compilation and generic preparation remain larger costs.

The first manual serialization experiment was discarded because allocation/JIT sensitivity obscured a consistent gain. The retained implementation reuses the unchanged fact builder and removes only its redundant canonical clone.

Focused regressions compare the new hash with the frozen canonical oracle for plain, typed, indexed, Unicode and rounding-edge data. Actual R4 delivery still matches admitted geometry; a self-consistent metadata bundle naming the wrong shape and malformed source are refused. Retained R3 warm/pending sharing and warm corruption refusal remain exercised. That cache fixture now explicitly selects its retained R3 Design rather than treating a newer default R4 as R3.

Reproduce from `apps/world` with `bun run scripts/physical-layout/source-hash-probe.ts /tmp/source-hash-pair.json` during a quiet CPU interval. Full-product before/after qualification must be recorded separately after combining the preparation and UI changes.

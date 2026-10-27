# One-map cold loading and floor transitions

This test-only runner drives the actual built local Host/World UI. It never opens the retired Layout Browser and never invokes a production Run. Keep the old `loading-product-probe.ts` and its historical receipts unchanged.

From `apps/world`:

```
LEITBILD_LOADING_TESTED_COMMIT=<exact-built-commit> bun --no-env-file run scripts/physical-layout/native-map-loading-probe.ts /absolute/qa-run.json /absolute/evidence-directory
```

`qa-run.json` must identify an isolated paused loopback Run with the actual retained four-unit PWR plus campus fixture. Its expected two source families and four/one instance cohorts are assertions about that test workload, not product limits. Use a fresh Chrome profile (created automatically), and restart the local service before claiming cold Run restoration. The runner records API timing/encoded bytes and WebSocket frame metadata without storing response bodies or source/Run payloads.

The 3D observer tags actual worker-prepared typed arrays, VBO/VAO uploads, semantic view keys and real draw calls. Full-site completion requires observing both source-family cohorts before inserting a fresh GPU fence after that drawing frame. DOM readiness and zero pending work cannot alone complete the fence. First-family draw, first draw of all required families, and their completed fence are distinct fields. GPU completion is not a physical-monitor timestamp.

Vector Plan uses a different milestone: actual Canvas2D ink for a matching prepared view and selected level, followed by two RAF scheduling frames with no pending work. The observer does not attach a WebGL fence or claim GPU completion for Canvas2D. Captions and a final screenshot support separate visual review; the complete motion runner checks required operating-floor captions and upright text.

The runner exercises first and revisited operating/Stack, uncut/inspection, Plan operating/lower, and Plan-to-3D transitions. Forced GC is a test stimulus, not a timing-dependent collection assertion. It records which variants actually needed preparation, owner evidence, and geometry uploads. Closing the page must leave no physical worker targets. Weak array/buffer tags and primitive-only logs preserve the application's asset lifetime behavior.

Reported timings distinguish Host URL navigation, World iframe navigation, and explicit full-site inspection dispatch. Comparing the old 2148/2194 ms action-only checkpoints with a new Host-navigation measurement would be invalid. Compare unchanged source/viewport/workload on a quiet machine when making speed claims; changed source quality must be qualified separately.

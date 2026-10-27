# Final native R4 map checkpoint — app 20a10558a

The user requested immediate deployment before further fixes. This report records the completed actual-product evidence and the remaining work, including four full-quality frame-time misses. It is not a universal 16.8ms acceptance claim.

The built app source is `20a10558a`, with test-only runner refinements on own branch `72a6d21ee`. The retained source Designs remain unit `b4458fe4ae078623b6b8f426950b34627a49844ca5fc83f2c2bf970aa1a5da82` and campus `4bc1d405da6a996902a3f799c7af009144fdf617886edfcaed4f72012983cb84`, compiler `738f7a053a2567552490e2c9147d2960a139dd8a8c06a5bfa4b5505d160d51f0`. The source worker admits all 744 unit and 540 campus objects; hidden geometry is deferred by the requested presentation, not removed from retained Plant truth.

## Default cold inspection and floors

Own local services were restarted, then a fresh isolated Chrome profile opened the retained paused Run. The driver waited for the public map startup overlay to finish, opened Layout controls through the real Host View menu, then requested 3D and All available layouts. Header-menu and map-startup time is separate from the physical-inspection action clock.

| Actual milestone | Milliseconds |
|---|---:|
|Physical inspection dispatch → first matching 3D draw|2068.0|
|Dispatch → both source families drawn, all five placements|2487.5|
|Dispatch → subsequent all-family GPU fence completed|2504.8|
|Host URL navigation → first matching draw|4075.1|
|Host URL navigation → all-source draw|4494.6|
|Unit source compilation response|1160.6|
|Campus source compilation response|739.7|
|Unit default preparation response, including queue/transfer|1041.0|
|Campus default preparation response, including queue/transfer|1088.2|
|First scoped turbine-hall focus, no new preparation|22.6|
|First operating-floor 3D draw|311.1|
|GC return to resident operating-floor 3D draw|40.8|
|First operating Plan ink / two-frame paint opportunity|188.0 /215.9|
|GC return to resident operating Plan ink / paint opportunity|8.5 /49.6|

Default layer demand prepares 13,556,352 unit render-buffer bytes and 15,233,904 campus bytes. Utilities and other currently hidden mesh layers remain in the exact immutable source and can be requested. The new layer policy therefore reduces work that previously prepared hidden geometry before filtering it from the draw. It does not establish a cold time for every layer enabled. Returning from Plan to operating 3D required another preparation (259.4ms to draw), so this report does not promise permanent residency of every visited variant.

## Real motion windows: default and full requested quality

The 32 windows use one native geographic map, actual input and actual paused/playing Run execution, at DPR1 and2. Each window lasts roughly four seconds. Every requested full-quality layer was enabled through the public per-layout controls on all five hierarchy-derived layout roots. The observer requires the actual submitted 3D VBO coverage keys to contain all source mesh-producing layer IDs. The JSON records each selected layer, its checked state and actual preparation responses. This multi-step UI setup is not a single cold all-layer action or a cold-load speedup claim.

| Workload | DPR | Site 3D paused / playing p95 | Site Plan paused / playing p95 | Room 3D and Plan, paused and playing |
|---|---:|---:|---:|---:|
|Default|1|16.8 /16.8ms|16.7 /16.7ms|16.7–16.8ms|
|Default|2|16.8 /16.8ms|16.7 /16.7ms|16.7–16.8ms|
|All declared layers enabled|1|16.8 /33.3ms|16.8 /16.8ms|16.7–16.8ms|
|All declared layers enabled|2|33.3 /33.4ms|33.4 /16.8ms|16.7–16.8ms|

Thus all 16 default windows meet the proposed 16.8ms p95 target. Four of 16 full-quality windows miss it. No JavaScript exception, pending preparation at settlement, or 50ms long task was observed in any of the 32 windows, and each closed page left zero physical worker targets. The earlier checkpoint's 88ms long task was not reproduced here; no causal fix for that individual task is claimed.

Actual room Plan paint includes 37 source caption strings, including HP, LP 1, GEN and TURBINE HALL; site Plan includes 149 unique strings. The four identical unit placements share one exact floor control; changing it preserves the campus's separate floor profile. Orbit input does not open an unintended process window. There is no alternate product Layout Browser or second product camera.

These are acceptance workloads, not a causal paused-versus-playing experiment: the current driver does not reset identical starting camera poses between those windows. Camera coverage, clipping and overdraw may therefore differ. Same-start-pose CPU/GPU tracing is the next diagnostic; the misses are preserved rather than attributed speculatively to live data.

## Allocation boundaries and remaining work

At DPR2 the actual map backing store is 2160 × 1742. Its owned 4-sample 3D target records 60,203,520 bytes each for the floating depth and color renderbuffers, plus 15,050,880 bytes for the resolve texture. Plan's Canvas adds a 15,050,880-byte RGBA lower bound. These are observed allocation inventories, not process RSS or total driver memory. The original-quality singleton Plan painter remains unchanged; separate independent original/native, exact-raster, cap, depth and ownership proofs cover visual correctness.

The earlier `fff1009a0` public startup and `7aa8370dd` routed-edge checkpoints passed and are retained separately. The final 20a visible Retry, held-response failure/rapid-toggle fixture and newly authored View → Grid operations briefing have not yet run when the user instructed deployment. They remain explicit follow-up tests, alongside matched-camera diagnosis of the full-quality frame-time misses. No new profile has been started during deployment.

[Compact measurements and exact raw receipt provenance](./FINAL-NATIVE-R4.json) include all 32 windows, source/coverage keys, worker stages, allocation inventories and screenshot paths. All operations use own paused loopback Runs; no production Run was modified. Local uncompressed transfer bytes do not estimate WAN transfer: production Caddy compression is a separate existing boundary. This is one browser/device profile, not a constrained-device or universal performance qualification.

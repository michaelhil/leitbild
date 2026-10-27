# Interim native-map Plan check — 27 October 2026

This is an early rendering and framing diagnostic, **not final source, visual-quality, cold-loading, live-status or complete-product acceptance**. The built app is `d569e94f4e4ad8a7a3e3bd63e699805dd1122b04`; it still uses the interim vertically mirrored R4 source. The subsequent canonical frame and routing changes are outside this receipt.

The actual built local Host/World used one MapLibre geographic viewport, the authored turbine-hall/feedwater-annex area and the +15 m operating floor. Each fresh Chrome profile received real native pan input for four seconds at 1440 × 913 outer CSS pixels. The map was 1080 × 871 CSS pixels after the visible plant rail. The architectural room occupied about 880 CSS pixels horizontally in the screenshot, beneath the measured controls. No alternate product canvas or synthetic camera was used.

Both DPR 1 and DPR 2 recorded 241 RAF intervals, 16.7 ms p95, zero long tasks, zero exceptions and zero new Path2D constructors during movement. Thirty actual caption strings were drawn, including HP, LP 1, GEN, TURBINE HALL, and the 88 m / 36 m dimensions. Paths were cached; measured native Canvas2D submission time was 47.4 ms and 52.4 ms respectively across the entire four-second windows. These CPU submission measurements include the test wrapper and are neither GPU execution time nor a physical-monitor timestamp.

The DPR 1 architectural backing store was 1080 × 871 (3,762,720 RGBA bytes); DPR 2 was 2160 × 1742 (15,050,880 RGBA bytes). The existing retained 3D float32/MSAA target also remained resident; exact observed stores appear in `early-plan.json`. These are backing-store counts, not process or driver memory. Page teardown left zero physical worker targets.

`early-plan.json` preserves compact measured fields plus absolute raw receipt/image paths and SHA256 hashes. The first launch failed before any page because the newly updated Chrome 156 startup exceeded the former four-second harness allowance; `early-plan-dpr1/failure.json` is retained. The runner now uses an explicit startup deadline and detects early process exit. No product timeout or rendering policy changed.

The test-only `native-map-product-probe.ts` supports full-site/room Plan and 3D, paused/playing, and DPR selection. `LEITBILD_NATIVE_EARLY_PLAN_ONLY=1` explicitly selects the bounded diagnostic above; it cannot be relabelled as the eight-window complete-product run.
